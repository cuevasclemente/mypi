import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

const APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const AGENT_TOKEN_HEADER = "X-Wayang-Apps-Agent-Token";
const SOURCE_SESSION_HEADER = "X-Wayang-Source-Session-Id";
const ACTOR_HEADER = "X-Wayang-Apps-Actor";

function backendBaseUrl(): string {
  return (process.env.WAYANG_URL || process.env["PI_WEB_UI_URL"] || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

function normalizeCwd(cwd: string): string {
  return path.resolve(cwd).replace(/\/+$/, "") || "/";
}

function ensureWithin(parent: string, child: string): void {
  const rel = path.relative(parent, child);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return;
  throw new Error("Path must be inside the project cwd");
}

function resolveManifest(cwd: string, manifestPath: string): string {
  const projectCwd = normalizeCwd(cwd);
  const resolved = path.isAbsolute(manifestPath)
    ? path.resolve(manifestPath)
    : path.resolve(projectCwd, manifestPath);
  ensureWithin(projectCwd, resolved);
  if (!fs.existsSync(resolved)) throw new Error(`Manifest not found: ${manifestPath}`);
  return resolved;
}

interface AppsAgentCapabilityBridge {
  forPiSession(piSessionId: string): { sourceSessionId: string; token: string } | undefined;
}

function requestHeaders(body: unknown, ctx: any): Record<string, string> {
  const piSessionId = ctx?.sessionManager?.getSessionId?.();
  const bridge = (globalThis as typeof globalThis & {
    __wayang_apps_agent_capabilities?: AppsAgentCapabilityBridge;
  }).__wayang_apps_agent_capabilities;
  const capability = typeof piSessionId === "string" ? bridge?.forPiSession(piSessionId) : undefined;
  if (!capability) throw new Error("Wayang did not provide session-attributed Apps authorization; reload the Wayang session and retry");

  const headers: Record<string, string> = {
    [ACTOR_HEADER]: "agent",
    [AGENT_TOKEN_HEADER]: capability.token,
    [SOURCE_SESSION_HEADER]: capability.sourceSessionId,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return headers;
}

async function apiRequest<T>(method: string, apiPath: string, body: unknown, signal: AbortSignal | undefined, ctx: any): Promise<T> {
  const res = await fetch(`${backendBaseUrl()}${apiPath}`, {
    method,
    signal,
    headers: requestHeaders(body, ctx),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const message = parsed?.error || parsed?.message || text || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

function result(text: string, details: unknown): ToolResult {
  return { content: [{ type: "text", text }], details };
}

export default function wayangApps(pi: ExtensionAPI) {
  pi.registerTool({
    name: "register_app",
    label: "Register App",
    description:
      "Register a project-local Wayang app manifest so it appears in the web UI Apps right pane. This tool does not generate app code or run npm install.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Expected app id; checked against the manifest id when provided" })),
      name: Type.Optional(Type.String({ description: "Optional expected app name for human confirmation" })),
      description: Type.Optional(Type.String({ description: "Optional description for the tool result" })),
      manifestPath: Type.String({ description: "Path to app.json, relative to project cwd or absolute inside it" }),
      projectCwd: Type.Optional(Type.String({ description: "Project cwd. Defaults to the current agent cwd." })),
      sessionId: Type.Optional(Type.String({ description: "Wayang session id, if known. Backend can also resolve by project cwd." })),
      open: Type.Optional(Type.Boolean({ description: "Return next-step instructions to open the Apps pane (default false)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const projectCwd = normalizeCwd(params.projectCwd || ctx.cwd);
        if (params.id && !APP_ID_RE.test(params.id)) throw new Error("Invalid expected app id");
        const absoluteManifest = resolveManifest(projectCwd, params.manifestPath);
        const manifest = JSON.parse(fs.readFileSync(absoluteManifest, "utf-8"));
        if (params.id && manifest.id !== params.id) {
          throw new Error(`Manifest id ${JSON.stringify(manifest.id)} does not match expected id ${JSON.stringify(params.id)}`);
        }

        const registered = await apiRequest<any>(
          "POST",
          "/api/apps/register",
          {
            sessionId: params.sessionId,
            projectCwd,
            manifestPath: path.relative(projectCwd, absoluteManifest),
          },
          signal,
          ctx,
        );
        const openHint = params.open ? "\nOpen the right pane Apps tab and launch/open this app." : "";
        return result(
          `Registered app ${registered.manifest?.name || registered.id} (${registered.id}) for ${projectCwd}.${openHint}`,
          { registered, backendUrl: backendBaseUrl(), requestedName: params.name, requestedDescription: params.description },
        );
      } catch (err: any) {
        return result(`register_app failed: ${err?.message || String(err)}`, { error: err?.message || String(err) });
      }
    },
  });

  pi.registerTool({
    name: "list_apps",
    label: "List Apps",
    description: "List project-local apps registered with wayang for the current or provided cwd.",
    parameters: Type.Object({
      projectCwd: Type.Optional(Type.String({ description: "Project cwd. Defaults to current agent cwd." })),
      sessionId: Type.Optional(Type.String({ description: "wayang session id, if known" })),
      scan: Type.Optional(Type.Boolean({ description: "Scan .pi/apps for manifests (default true)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const projectCwd = normalizeCwd(params.projectCwd || ctx.cwd);
        const query = new URLSearchParams({ project_cwd: projectCwd, scan: params.scan === false ? "0" : "1" });
        if (params.sessionId) query.set("session_id", params.sessionId);
        const apps = await apiRequest<any[]>("GET", `/api/apps?${query.toString()}`, undefined, signal, ctx);
        return result(`Found ${apps.length} app(s) for ${projectCwd}.`, { apps, backendUrl: backendBaseUrl() });
      } catch (err: any) {
        return result(`list_apps failed: ${err?.message || String(err)}`, { error: err?.message || String(err) });
      }
    },
  });

  pi.registerTool({
    name: "start_app",
    label: "Start App",
    description: "Start a registered Wayang app managed process. If any protected project is registered, agent launch fails closed and the reviewed app must be started manually from the authenticated Apps pane.",
    parameters: Type.Object({
      appId: Type.String({ description: "App id" }),
      projectCwd: Type.Optional(Type.String({ description: "Project cwd. Defaults to current agent cwd." })),
      sessionId: Type.Optional(Type.String({ description: "wayang session id, if known" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const app = await apiRequest<any>("POST", `/api/apps/${encodeURIComponent(params.appId)}/start`, {
          sessionId: params.sessionId,
          projectCwd: normalizeCwd(params.projectCwd || ctx.cwd),
        }, signal, ctx);
        return result(`Started app ${app.id} at ${app.url || "(no URL)"}.`, { app });
      } catch (err: any) {
        return result(`start_app failed: ${err?.message || String(err)}`, { error: err?.message || String(err) });
      }
    },
  });

  pi.registerTool({
    name: "stop_app",
    label: "Stop App",
    description: "Stop a registered wayang app managed process.",
    parameters: Type.Object({
      appId: Type.String({ description: "App id" }),
      projectCwd: Type.Optional(Type.String({ description: "Project cwd. Defaults to current agent cwd." })),
      sessionId: Type.Optional(Type.String({ description: "wayang session id, if known" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const app = await apiRequest<any>("POST", `/api/apps/${encodeURIComponent(params.appId)}/stop`, {
          sessionId: params.sessionId,
          projectCwd: normalizeCwd(params.projectCwd || ctx.cwd),
        }, signal, ctx);
        return result(`Stopped app ${app.id}.`, { app });
      } catch (err: any) {
        return result(`stop_app failed: ${err?.message || String(err)}`, { error: err?.message || String(err) });
      }
    },
  });

  pi.registerTool({
    name: "update_app_state",
    label: "Update App State",
    description: "Set structured bridge state for a registered wayang app. The Apps pane forwards it to the iframe when open.",
    parameters: Type.Object({
      appId: Type.String({ description: "App id" }),
      state: Type.Any({ description: "JSON-serializable state to store and send to the app" }),
      projectCwd: Type.Optional(Type.String({ description: "Project cwd. Defaults to current agent cwd." })),
      sessionId: Type.Optional(Type.String({ description: "wayang session id, if known" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const record = await apiRequest<any>("PUT", `/api/apps/${encodeURIComponent(params.appId)}/state`, {
          sessionId: params.sessionId,
          projectCwd: normalizeCwd(params.projectCwd || ctx.cwd),
          state: params.state,
        }, signal, ctx);
        return result(`Updated app state for ${params.appId}.`, { state: record });
      } catch (err: any) {
        return result(`update_app_state failed: ${err?.message || String(err)}`, { error: err?.message || String(err) });
      }
    },
  });
}

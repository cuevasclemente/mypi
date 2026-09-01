import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

type BrowserControlMode = "agent" | "user" | "paused";

type BrowserLifecycleStatus = "stopped" | "starting" | "running" | "errored";

/** The only browser runtime fields that may enter model-visible tool results. */
interface BrowserSessionState {
  status: BrowserLifecycleStatus;
  controlMode: BrowserControlMode;
  needsUser: boolean;
  needsUserReason?: string;
  activeUrl?: string;
  activeTitle?: string;
  credentialInspection?: "blocked" | "text-allowed";
}

interface BrowserHandoffView {
  handoffId: string;
  status: "pending" | "completed" | "failed" | "expired" | "cancelled";
  reason: string;
  createdAt: number;
  expiresAt: number;
  terminalAt?: number;
  failure?: "resume_failed";
}

interface BrowserHandoffInspection {
  active: BrowserHandoffView | null;
  lastTerminal: BrowserHandoffView | null;
}

const AGENT_TOKEN_HEADER = "X-Wayang-Browser-Agent-Token";
const SOURCE_SESSION_HEADER = "X-Wayang-Source-Session-Id";
const ACTOR_HEADER = "X-Wayang-Browser-Actor";

const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const COMMAND_TOOL_NAMES = new Set(["bash", "sudo_exec", "exec", "shell", "run", "run_command"]);
const PATH_FIELD = /(?:^|_)(?:path|paths|file|files|cwd|directory|dir|root|glob)(?:$|_)/i;
const PROTECTED_BROWSER_PATH = /(?:^|[\\/])(?:\.pi[\\/])?(?:browser-workbench|browser-artifacts|secret-browser)(?:[\\/]|$)|(?:^|[\\/]|wayang[-_])(?:browser[-_]credentials?|credential[-_]broker|credentials?[-_]helper)(?:[\\/._-]|$)|(?:^|[\\/])browser[\\/]credentials?(?:[\\/._-]|$)|(?:^|[\\/])credentials?(?:\.(?:ts|js|mjs|cjs)|[\\/])|(?:^|[\\/])(?:\.config[\\/])?(?:chromium|google-chrome|chrome|BraveSoftware[\\/]Brave-Browser|mozilla[\\/]firefox)(?:[\\/]|$)|(?:^|[\\/])(?:Cookies|Login Data|Web Data|Local Storage|Session Storage|IndexedDB|DevToolsActivePort|storage[-_.]?state(?:\.json)?)(?:[\\/._-]|$)/i;
const CREDENTIAL_API = /(?:^|["'\s])(?:https?:\/\/[^\s"']+)?\/api\/browser\/credentials(?:[/?#"'\s]|$)/i;
const LOOPBACK_CDP = /(?:https?|wss?):\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[?::1\]?)(?::\d+)?\/(?:json(?:\/|\?|#|$)|devtools\/)|--remote-debugging-(?:port|address)\b|DevToolsActivePort/i;
const CHROME_CREDENTIAL_UI = /chrome:\/\/(?:password-manager|settings\/passwords)(?:[/?#]|$)/i;
const BW_INVOCATION = /(?:^|[\n;&|()])\s*(?:(?:command|sudo|env)\s+)*(?:[^\s;&|()]*[\\/])?bw\b([^\n;&|]*)/gi;
const RAW_BW_SUBCOMMAND = /\bbw\b[^\n;&|]*\b(?:get|list|export|unlock|serve)\b/i;
const BW_SESSION_REFERENCE = /(?:^|[^A-Za-z0-9_])BW_SESSION(?:[^A-Za-z0-9_]|$)/;
const INTERNAL_TOKEN_REFERENCE = /(?:^|[^A-Za-z0-9_])WAYANG_BROWSER_AGENT_TOKEN(?:[^A-Za-z0-9_]|$)/;
const BROAD_ENV_DUMP = /(?:^|[;&|()]\s*)(?:\/usr\/bin\/)?(?:env|printenv)\s*(?:$|[;&|])|(?:^|[;&|()]\s*)(?:set|export|declare\s+-[xp])\s*(?:$|[;&|])/m;

class BrowserApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BrowserApiError";
  }
}

function backendBaseUrl(): string {
  return (process.env.WAYANG_URL || process.env.PI_WEB_UI_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

interface BrowserAgentCapability {
  readonly sourceSessionId: string;
  readonly token: string;
}

interface BrowserAgentCapabilityBridge {
  forPiSession(piSessionId: string): BrowserAgentCapability | undefined;
}

function resolveCapability(ctx: any): Readonly<BrowserAgentCapability> {
  const piSessionId = ctx?.sessionManager?.getSessionId?.();
  const bridge = (globalThis as typeof globalThis & {
    __wayang_browser_agent_capabilities?: BrowserAgentCapabilityBridge;
  }).__wayang_browser_agent_capabilities;
  const capability = typeof piSessionId === "string" ? bridge?.forPiSession(piSessionId) : undefined;
  if (!capability || typeof capability.sourceSessionId !== "string" || typeof capability.token !== "string") {
    throw new Error("Wayang did not provide session-attributed browser authorization");
  }
  return Object.freeze({ sourceSessionId: capability.sourceSessionId, token: capability.token });
}

function requestHeaders(body: unknown, capability: Readonly<BrowserAgentCapability>): Record<string, string> {
  const headers: Record<string, string> = {
    [ACTOR_HEADER]: "agent",
    [AGENT_TOKEN_HEADER]: capability.token,
    [SOURCE_SESSION_HEADER]: capability.sourceSessionId,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return headers;
}

async function apiRequest<T>(method: string, operation: string, body: unknown, signal: AbortSignal | undefined, capability: Readonly<BrowserAgentCapability>): Promise<T> {
  const res = await fetch(`${backendBaseUrl()}/api/browser/agent/${operation}`, {
    method,
    signal,
    headers: requestHeaders(body, capability),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    if (res.status === 409) {
      throw new BrowserApiError(409, "Browser agent access is gated. For an ordinary user pause, Clemente must use Resume agent in the Browser pane. After credential handling, Allow agent redacted inspection permits text/DOM reads only; credential-gated screenshots and mutations have no allow control and require Clemente to finish the sensitive step and reach a confirmed new top-level document before retrying.");
    }
    const message = parsed?.error || parsed?.message || text || `HTTP ${res.status}`;
    throw new BrowserApiError(res.status, message);
  }
  return parsed as T;
}

function isBrowserState(value: Record<string, unknown>): boolean {
  return typeof value.status === "string"
    && typeof value.controlMode === "string"
    && typeof value.needsUser === "boolean";
}

function publicBrowserState(value: Record<string, unknown>): BrowserSessionState {
  return {
    status: value.status as BrowserLifecycleStatus,
    controlMode: value.controlMode as BrowserControlMode,
    needsUser: value.needsUser as boolean,
    ...(typeof value.needsUserReason === "string" ? { needsUserReason: value.needsUserReason } : {}),
    ...(typeof value.lastResumeAt === "number" ? { lastResumeAt: value.lastResumeAt } : {}),
    ...(typeof value.activeUrl === "string" ? { activeUrl: value.activeUrl } : {}),
    ...(typeof value.activeTitle === "string" ? { activeTitle: value.activeTitle } : {}),
    ...(value.credentialInspection === "blocked" || value.credentialInspection === "text-allowed"
      ? { credentialInspection: value.credentialInspection }
      : {}),
  };
}

function sanitizeDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (isBrowserState(record)) return publicBrowserState(record);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== "backendUrl")
    .map(([key, nested]) => [key, sanitizeDetails(nested)]));
}

function result(text: string, details: unknown): ToolResult {
  return { content: [{ type: "text", text }], details: sanitizeDetails(details) };
}

function toolFailure(toolName: string, err: unknown): ToolResult {
  if (err instanceof BrowserApiError && err.status === 409) {
    return result(`${toolName} paused: ${err.message}`, { paused: true, httpStatus: 409 });
  }
  const message = err instanceof Error ? err.message : String(err);
  return result(`${toolName} failed: ${message}`, { error: message });
}

function summarizeCredentialInspection(state: BrowserSessionState): string | undefined {
  if (state.credentialInspection === "blocked") {
    return "credential_inspection=blocked (redacted text/DOM inspection needs Credentials drawer approval; screenshots/mutations remain gated)";
  }
  if (state.credentialInspection === "text-allowed") {
    return "credential_inspection=text-allowed (redacted text/DOM read-only; screenshots/mutations remain gated until a confirmed new top-level document)";
  }
  return undefined;
}

function summarizeState(state: BrowserSessionState): string {
  const parts = [
    `status=${state.status}`,
    `control=${state.controlMode}`,
    state.activeTitle ? `title=${JSON.stringify(state.activeTitle)}` : undefined,
    state.activeUrl ? `url=${state.activeUrl}` : undefined,
    state.needsUser ? `needs_user=${JSON.stringify(state.needsUserReason || "yes")}` : undefined,
    summarizeCredentialInspection(state),
  ].filter(Boolean);
  return parts.join("; ");
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(stringValues);
}

function pathValues(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    if (PATH_FIELD.test(key)) return stringValues(nested);
    return nested && typeof nested === "object" ? pathValues(nested) : [];
  });
}

function hasUnsafeBwInvocation(command: string): boolean {
  BW_INVOCATION.lastIndex = 0;
  for (const match of command.matchAll(BW_INVOCATION)) {
    const args = (match[1] || "").trim();
    if (args !== "--version" && args !== "version" && args !== "status") return true;
  }
  return false;
}

/**
 * Defense-in-depth against accidental same-user access. This cannot stop an
 * agent from obfuscating a command or using an unrecognized custom tool.
 */
export function browserControlGuardReason(toolName: string, input: unknown): string | null {
  const strings = stringValues(input);
  if (strings.some((value) => CREDENTIAL_API.test(value))) {
    return "Blocked: browser credential API routes are UI-only and must never be exposed to the model.";
  }
  if (strings.some((value) => LOOPBACK_CDP.test(value) || CHROME_CREDENTIAL_UI.test(value))) {
    return "Blocked: direct loopback CDP discovery/debug and browser credential UI access are not agent tools.";
  }

  const baseToolName = toolName.split(/[.:/]/).pop() || toolName;
  if (FILE_TOOL_NAMES.has(baseToolName) && pathValues(input).some((value) => PROTECTED_BROWSER_PATH.test(value))) {
    return "Blocked: browser profiles, cookies, storage state, and credential broker/helper paths are bearer-sensitive.";
  }

  if (COMMAND_TOOL_NAMES.has(baseToolName)) {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const command = typeof record.command === "string"
      ? record.command
      : typeof record.executable === "string"
        ? [record.executable, ...stringValues(record.argv)].join(" ")
        : strings.join("\n");
    if (INTERNAL_TOKEN_REFERENCE.test(command) || BROAD_ENV_DUMP.test(command)) {
      return "Blocked: the internal browser authorization capability is process-private and environment dumps are not available through agent tools.";
    }
    if (BW_SESSION_REFERENCE.test(command) || RAW_BW_SUBCOMMAND.test(command) || hasUnsafeBwInvocation(command)) {
      return "Blocked: raw Bitwarden secret operations and BW_SESSION access are not available to the model. Only exact bw --version/version/status metadata commands are allowed.";
    }
    if (PROTECTED_BROWSER_PATH.test(command)) {
      return "Blocked: shell access to browser profiles, cookies/storage, or credential broker/socket/helper internals is not available to the model.";
    }
  }

  return null;
}

function summarizeElements(elements: any[], limit = 30): string {
  if (!Array.isArray(elements) || elements.length === 0) return "(no elements)";
  return elements.slice(0, limit).map((el) => {
    const label = el.name || el.text || el.placeholder || el.value || "";
    const bits = [
      `#${el.index}`,
      el.role || el.tag,
      label ? JSON.stringify(String(label).slice(0, 120)) : undefined,
      el.href ? `href=${el.href}` : undefined,
      el.selector ? `selector=${el.selector}` : undefined,
    ].filter(Boolean);
    return bits.join(" ");
  }).join("\n");
}

function summarizeLinks(links: any[], limit = 50): string {
  if (!Array.isArray(links) || links.length === 0) return "(no links)";
  return links.slice(0, limit).map((link) => `#${link.index} ${JSON.stringify(String(link.text || "").slice(0, 120))} -> ${link.href}\n  selector=${link.selector}`).join("\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }, { once: true });
  });
}

export default function browserControl(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    const reason = browserControlGuardReason(event.toolName, event.input);
    if (reason) return { block: true, reason };
  });

  pi.registerTool({
    name: "browser_status",
    label: "Browser Status",
    description: "Return the public state of Wayang's shared embedded browser workbench.",
    parameters: Type.Object({}),
    promptSnippet: "Inspect the shared Wayang embedded Chromium browser state.",
    promptGuidelines: [
      "Use browser_status before browser automation when you need to know whether Chromium is already running or waiting for user control.",
      "Browser profiles/cookies are bearer-sensitive once logged in; do not read profile files directly.",
    ],
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const state = await apiRequest<BrowserSessionState>("POST", "status", {}, signal, capability);
        return result(`Browser status: ${summarizeState(state)}`, { state });
      } catch (err: any) {
        return toolFailure("browser_status", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_open",
    label: "Open Browser",
    description: "Start Wayang's shared embedded Chromium browser, optionally navigating to a URL.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Optional URL to navigate to after startup" })),
    }),
    promptSnippet: "Start the shared Wayang embedded Chromium browser.",
    promptGuidelines: [
      "Use browser_open for public/non-secret web workflows such as flight search.",
      "Do not ask the user for passwords/TOTP in chat; use browser_wait_for_user for login, CAPTCHA, passkeys, payment, or MFA.",
    ],
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        // Capture one exact source/runtime lease for the whole start+navigate call.
        const capability = resolveCapability(ctx);
        let state = await apiRequest<BrowserSessionState>("POST", "start", {}, signal, capability);
        if (params.url) {
          state = await apiRequest<BrowserSessionState>("POST", "navigate", { url: params.url }, signal, capability);
        }
        return result(`Browser open: ${summarizeState(state)}. Open the Wayang Browser tab to watch or interact.`, { state });
      } catch (err: any) {
        return toolFailure("browser_open", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate the shared Wayang embedded browser to a URL.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const state = await apiRequest<BrowserSessionState>("POST", "navigate", { url: params.url }, signal, capability);
        return result(`Navigated browser: ${summarizeState(state)}`, { state });
      } catch (err: any) {
        return toolFailure("browser_navigate", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Read the current page title/url and visible text or screenshot from the embedded browser.",
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("screenshot")], { description: "Snapshot mode. Default: text" })),
    }),
    promptSnippet: "Inspect current embedded browser page text or screenshot.",
    promptGuidelines: [
      "Only snapshot pages appropriate for the active model/provider; authenticated page contents may enter model context.",
      "If a page contains passwords, recovery codes, payment details, or other secrets, stop and ask the user how to proceed.",
    ],
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const snapshot = await apiRequest<any>("POST", "snapshot", { mode: params.mode || "text" }, signal, capability);
        const text = params.mode === "screenshot"
          ? `Browser screenshot captured for ${snapshot.title || snapshot.url || "current page"}.`
          : `Browser snapshot: ${snapshot.title || "(untitled)"}\n${snapshot.url || ""}\n\n${String(snapshot.text || "").slice(0, 4000)}`;
        return result(text, { snapshot, warning: "Authenticated page contents may be sensitive and are now in tool output." });
      } catch (err: any) {
        return toolFailure("browser_snapshot", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_dom_snapshot",
    label: "Browser DOM Snapshot",
    description: "Inspect the current page through Chromium CDP and return structured visible controls, links, fields, headings, and optional page text.",
    parameters: Type.Object({
      includeText: Type.Optional(Type.Boolean({ description: "Also include document.body.innerText. Default false." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of elements to return. Default 80, max 300." })),
    }),
    promptSnippet: "Inspect a page structurally through Chromium CDP instead of relying on screenshots.",
    promptGuidelines: [
      "Prefer browser_dom_snapshot before coordinate clicking; use returned selectors with selector tools.",
      "Authenticated page contents may enter model context. Do not inspect pages containing passwords, recovery codes, payment details, or other secrets unless Clemente explicitly authorizes it.",
    ],
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const snapshot = await apiRequest<any>("POST", "dom-snapshot", { includeText: Boolean(params.includeText), limit: params.limit }, signal, capability);
        const text = `Browser DOM snapshot: ${snapshot.title || "(untitled)"}\n${snapshot.url || ""}\n\n${summarizeElements(snapshot.elements)}${params.includeText ? `\n\nPage text:\n${String(snapshot.text || "").slice(0, 4000)}` : ""}`;
        return result(text, { snapshot, warning: "Page contents/selectors may be sensitive and are now in tool output." });
      } catch (err: any) {
        return toolFailure("browser_dom_snapshot", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_query_selector",
    label: "Browser Query Selector",
    description: "Query CSS selectors in the embedded browser via Chromium CDP and return matching element summaries.",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector to query" }),
      limit: Type.Optional(Type.Number({ description: "Maximum matches. Default 25, max 200." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const query = await apiRequest<any>("POST", "query-selector", { selector: params.selector, limit: params.limit }, signal, capability);
        return result(`Selector ${JSON.stringify(params.selector)} matched ${query.elements?.length || 0} element(s):\n${summarizeElements(query.elements)}`, { query });
      } catch (err: any) {
        return toolFailure("browser_query_selector", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_click_selector",
    label: "Browser Click Selector",
    description: "Click an element matched by a CSS selector in the embedded browser via Chromium CDP. Prefer user handoff for sensitive or irreversible actions.",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector to click" }),
      index: Type.Optional(Type.Number({ description: "Zero-based match index. Default 0." })),
    }),
    promptGuidelines: [
      "Use selectors from browser_dom_snapshot or browser_query_selector when possible.",
      "Do not use this for final purchase/booking/submission/account deletion steps without explicit Clemente confirmation.",
    ],
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const state = await apiRequest<BrowserSessionState>("POST", "click-selector", { selector: params.selector, index: params.index ?? 0 }, signal, capability);
        return result(`Clicked selector ${JSON.stringify(params.selector)} index ${params.index ?? 0}: ${summarizeState(state)}`, { state });
      } catch (err: any) {
        return toolFailure("browser_click_selector", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_fill_selector",
    label: "Browser Fill Selector",
    description: "Fill a CSS-selected input/textarea/select/contenteditable element with non-secret public text via Chromium CDP. Do not use for passwords, TOTP, payment details, or private secrets.",
    parameters: Type.Object({
      selector: Type.String({ description: "CSS selector for the field to fill" }),
      text: Type.String({ description: "Non-secret public text to fill" }),
      index: Type.Optional(Type.Number({ description: "Zero-based match index. Default 0." })),
    }),
    promptGuidelines: [
      "Only fill non-secret public text. For credentials, MFA, CAPTCHA, payment details, SSNs, or other secrets, use browser_wait_for_user.",
      "Prefer selector filling over coordinate clicking plus typing when the field can be identified structurally.",
    ],
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const state = await apiRequest<BrowserSessionState>("POST", "fill-selector", { selector: params.selector, text: params.text, index: params.index ?? 0 }, signal, capability);
        return result(`Filled selector ${JSON.stringify(params.selector)} index ${params.index ?? 0}: ${summarizeState(state)}`, { state });
      } catch (err: any) {
        return toolFailure("browser_fill_selector", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_extract_links",
    label: "Browser Extract Links",
    description: "Extract links and generated selectors from the current embedded browser page through Chromium CDP.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Maximum links. Default 100, max 500." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const links = await apiRequest<any>("POST", "links", { limit: params.limit }, signal, capability);
        return result(`Browser links: ${links.title || "(untitled)"}\n${links.url || ""}\n\n${summarizeLinks(links.links)}`, { links });
      } catch (err: any) {
        return toolFailure("browser_extract_links", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_accessibility_snapshot",
    label: "Browser Accessibility Snapshot",
    description: "Read a simplified Chromium accessibility tree for the current page, useful for identifying semantic controls without visual inspection.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Maximum accessibility nodes. Default 120, max 500." })),
    }),
    promptGuidelines: [
      "Use this when DOM selectors are unclear or the page relies on ARIA roles.",
      "Authenticated page contents may enter model context; avoid secret-bearing pages unless Clemente authorizes it.",
    ],
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const ax = await apiRequest<any>("POST", "accessibility", { limit: params.limit }, signal, capability);
        const nodes = Array.isArray(ax.nodes) ? ax.nodes : [];
        const summary = nodes.slice(0, 80).map((node: any, index: number) => `#${index} ${node.role || "node"} ${node.name ? JSON.stringify(String(node.name).slice(0, 160)) : ""}${node.value ? ` value=${JSON.stringify(String(node.value).slice(0, 80))}` : ""}`).join("\n") || "(no accessibility nodes)";
        return result(`Browser accessibility snapshot: ${ax.title || "(untitled)"}\n${ax.url || ""}\n\n${summary}`, { accessibility: ax, warning: "Accessibility text may include sensitive page contents." });
      } catch (err: any) {
        return toolFailure("browser_accessibility_snapshot", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click absolute viewport coordinates in the embedded browser. Prefer user handoff for sensitive/irreversible actions.",
    parameters: Type.Object({
      x: Type.Number({ description: "Viewport x coordinate" }),
      y: Type.Number({ description: "Viewport y coordinate" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const state = await apiRequest<BrowserSessionState>("POST", "click", { x: params.x, y: params.y }, signal, capability);
        return result(`Clicked browser at ${params.x},${params.y}.`, { state });
      } catch (err: any) {
        return toolFailure("browser_click", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_type_public",
    label: "Browser Type Public",
    description: "Type non-secret public text into the focused embedded-browser field. Do not use for passwords, TOTP, payment details, or private secrets.",
    parameters: Type.Object({
      text: Type.String({ description: "Non-secret text to type" }),
    }),
    promptSnippet: "Type non-secret text into the embedded browser.",
    promptGuidelines: [
      "Never use browser_type_public for passwords, TOTP, passkeys, CAPTCHA answers, payment details, SSNs, or other secrets.",
      "For sensitive inputs, call browser_wait_for_user and let Clemente type directly in the Browser tab.",
    ],
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const state = await apiRequest<BrowserSessionState>("POST", "type-public", { text: params.text }, signal, capability);
        return result(`Typed public text into browser.`, { state });
      } catch (err: any) {
        return toolFailure("browser_type_public", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_wait_for_user",
    label: "Browser Wait For User",
    description: "Pause browser automation and wait for the user to handle login, MFA, CAPTCHA, payment, booking, or other sensitive/manual steps in the Browser tab.",
    parameters: Type.Object({
      reason: Type.String({ description: "What the user should handle before resuming" }),
      timeoutMs: Type.Optional(Type.Number({ description: "How long to wait for resume; default 10 minutes" })),
    }),
    promptSnippet: "Pause browser automation until the user resumes from the Browser tab.",
    promptGuidelines: [
      "Use browser_wait_for_user for login, CAPTCHA, MFA/TOTP, passkeys, payment, booking, account changes, deletion, or uncertain sensitive steps.",
      "Do not finalize purchases/bookings without explicit user confirmation in chat or Browser tab.",
    ],
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        // Keep one exact lease and one exact handoff ID for the entire wait.
        const capability = resolveCapability(ctx);
        const timeoutMs = Math.min(60 * 60 * 1000, Math.max(1_000, Math.floor(Number(params.timeoutMs) || 10 * 60 * 1000)));
        const startedAt = Date.now();
        const created = await apiRequest<{ handoff: BrowserHandoffView; state: BrowserSessionState }>(
          "POST",
          "handoff",
          { reason: params.reason, timeoutMs },
          signal,
          capability,
        );
        const handoffId = created.handoff.handoffId;
        let latest = created;
        while (Date.now() - startedAt < timeoutMs) {
          await sleep(1_000, signal);
          latest = await apiRequest<{ handoff: BrowserHandoffView; state: BrowserSessionState }>(
            "POST",
            "handoff-status",
            { handoffId },
            signal,
            capability,
          );
          if (latest.handoff.status === "completed") {
            return result(`User returned browser control: ${summarizeState(latest.state)}`, { ...latest, resumed: true });
          }
          if (latest.handoff.status !== "pending") {
            return result(`Browser handoff ended with status=${latest.handoff.status}; human control remains active.`, { ...latest, resumed: false });
          }
        }
        latest = await apiRequest<{ handoff: BrowserHandoffView; state: BrowserSessionState }>(
          "POST",
          "handoff-status",
          { handoffId },
          signal,
          capability,
        );
        return result(`Still in human control after ${Math.round(timeoutMs / 1000)}s. Open the Browser tab to review the exact handoff; timeout never returns control automatically.`, { ...latest, resumed: false });
      } catch (err: any) {
        return toolFailure("browser_wait_for_user", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_resume_status",
    label: "Browser Resume Status",
    description: "Check whether the Browser tab has resumed agent control after a user handoff.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const response = await apiRequest<{ handoff: BrowserHandoffInspection; state: BrowserSessionState }>(
          "POST",
          "handoff-status",
          {},
          signal,
          capability,
        );
        const resumed = response.handoff.active === null && response.handoff.lastTerminal?.status === "completed";
        const exact = response.handoff.active ?? response.handoff.lastTerminal;
        return result(`Browser resume status: ${exact ? `handoff=${exact.status}; ` : "no exact handoff; "}${summarizeState(response.state)}`, { ...response, resumed });
      } catch (err: any) {
        return toolFailure("browser_resume_status", err);
      }
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Close Browser",
    description: "Stop the shared Wayang embedded Chromium browser process without deleting its persistent profile.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      try {
        const capability = resolveCapability(ctx);
        const state = await apiRequest<BrowserSessionState>("POST", "stop", {}, signal, capability);
        return result(`Browser closed: ${summarizeState(state)}`, { state });
      } catch (err: any) {
        return toolFailure("browser_close", err);
      }
    },
  });
}

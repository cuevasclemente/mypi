import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const COMPANION_POLICY_SCHEMA_VERSION = 1;
export const CHILD_SAFE_PATH_TOOLS = ["read", "edit", "write", "grep", "find", "ls"] as const;
const CHILD_SAFE_PATH_TOOL_SET = new Set<string>(CHILD_SAFE_PATH_TOOLS);
const CHILD_RECURSIVE_PATH_TOOLS = new Set(["grep", "find", "ls"]);
const LEGACY_ATTACHMENT_ROOT = "/tmp/wayang-attachments";
const COMMAND_GUARD_PIN_FILENAME = "command-guard-identity-pin";
const COMMAND_GUARD_PIN_ENV_RE = /(?:COMMAND_GUARD.*PIN|PIN.*COMMAND_GUARD|IDENTITY_PIN)/i;

export interface CompanionProjectPolicy {
  cwd: string;
  privacy_mode: "standard" | "protected";
  allowed_agent_profile_ids: string[] | null;
  dream: boolean;
  scheduled: boolean;
  subagents: boolean;
  global_index: boolean;
}

export interface CompanionSessionPolicy {
  session_id: string;
  path: string;
  cwd: string;
  dream: boolean;
  agent_profile_id: string | null;
}

export interface CompanionPolicyProjection {
  schema_version: 1;
  generation: number;
  complete: true;
  source_store: {
    size: number;
    mtime_ms: number;
    ctime_ms: number;
    ino: number;
  };
  projects: CompanionProjectPolicy[];
  sessions: CompanionSessionPolicy[];
}

export interface SubagentLaunchAuthorization {
  generation: number;
  projectionPath: string;
  parentProjectCwd: string;
  targetProjectCwd: string;
  effectiveTools: string[];
  allowPrivilegedExec: boolean;
  protectedProjectsPresent: boolean;
  sourceAgentProfileId: string | null;
}

export class CompanionPolicyDeniedError extends Error {
  readonly code = "COMPANION_POLICY_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "CompanionPolicyDeniedError";
  }
}

function deny(message: string): never {
  throw new CompanionPolicyDeniedError(message);
}

export function companionPolicyProjectionPath(): string {
  const dataDir = process.env.WAYANG_DATA_DIR
    || process.env.PI_WEB_UI_DATA_DIR
    || path.join(os.homedir(), ".wayang");
  return process.env.WAYANG_PROJECT_POLICY_PROJECTION
    || path.join(dataDir, "project-access-policy.json");
}

function finiteFingerprint(source: unknown): source is CompanionPolicyProjection["source_store"] {
  if (!source || typeof source !== "object") return false;
  const value = source as Record<string, unknown>;
  return [value.size, value.mtime_ms, value.ctime_ms, value.ino]
    .every((item) => typeof item === "number" && Number.isFinite(item));
}

function canonicalExistingDirectory(target: string, label: string): string {
  if (!path.isAbsolute(target)) deny(`${label} must be an absolute path`);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(target);
  } catch {
    deny(`${label} is unavailable`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch {
    deny(`${label} cannot be inspected`);
  }
  if (!stat.isDirectory()) deny(`${label} is not a directory`);
  return canonical;
}

function canonicalProjectedDirectory(target: string): string {
  const resolved = path.resolve(target);
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return resolved;
    deny("Companion policy project cwd cannot be inspected");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch {
    deny("Companion policy project cwd cannot be inspected");
  }
  if (!stat.isDirectory()) deny("Companion policy project cwd is not a directory");
  return canonical;
}

export function pathIsWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateProject(value: unknown): CompanionProjectPolicy {
  if (!value || typeof value !== "object") deny("Companion policy contains an invalid project");
  const project = value as Record<string, unknown>;
  if (typeof project.cwd !== "string" || !path.isAbsolute(project.cwd)) {
    deny("Companion policy contains an invalid project cwd");
  }
  if (project.privacy_mode !== "standard" && project.privacy_mode !== "protected") {
    deny("Companion policy contains an invalid privacy mode");
  }
  if (project.allowed_agent_profile_ids !== null
    && (!Array.isArray(project.allowed_agent_profile_ids)
      || project.allowed_agent_profile_ids.some((id) => typeof id !== "string" || !id))) {
    deny("Companion policy contains an invalid agent allowlist");
  }
  for (const flag of ["dream", "scheduled", "subagents", "global_index"] as const) {
    if (typeof project[flag] !== "boolean") deny(`Companion policy contains an invalid ${flag} decision`);
  }
  if (project.privacy_mode === "protected"
    && (project.dream !== false || project.scheduled !== false
      || project.subagents !== false || project.global_index !== false)) {
    deny("Companion policy contains contradictory protected-project decisions");
  }
  return project as unknown as CompanionProjectPolicy;
}

function validateSession(value: unknown): CompanionSessionPolicy {
  if (!value || typeof value !== "object") deny("Companion policy contains an invalid session mapping");
  const session = value as Record<string, unknown>;
  if (typeof session.session_id !== "string" || !session.session_id
    || typeof session.path !== "string" || !path.isAbsolute(session.path)
    || typeof session.cwd !== "string" || !path.isAbsolute(session.cwd)
    || typeof session.dream !== "boolean"
    || (session.agent_profile_id !== null
      && (typeof session.agent_profile_id !== "string" || !session.agent_profile_id))) {
    deny("Companion policy contains an invalid session identity mapping");
  }
  return session as unknown as CompanionSessionPolicy;
}

/** Load one complete, private projection and prove that it matches store.json. */
export function loadCompanionPolicyProjection(
  projectionPath = companionPolicyProjectionPath(),
): CompanionPolicyProjection {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(projectionPath);
  } catch {
    deny("Companion policy projection is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) deny("Companion policy projection must be a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    deny("Companion policy projection is not private");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) deny("Companion policy projection is malformed");
    deny("Companion policy projection cannot be read");
  }
  if (!parsed || typeof parsed !== "object") deny("Companion policy projection is malformed");
  const value = parsed as Record<string, unknown>;
  if (value.schema_version !== COMPANION_POLICY_SCHEMA_VERSION
    || value.complete !== true
    || !Number.isInteger(value.generation)
    || (value.generation as number) < 1
    || !finiteFingerprint(value.source_store)
    || !Array.isArray(value.projects)
    || !Array.isArray(value.sessions)) {
    deny("Companion policy projection is incomplete or unsupported");
  }

  const storePath = path.join(path.dirname(projectionPath), "store.json");
  let store: fs.Stats;
  try {
    store = fs.lstatSync(storePath);
  } catch {
    deny("Companion policy source store is unavailable");
  }
  const source = value.source_store;
  if (!store.isFile() || store.isSymbolicLink()
    || store.size !== source.size
    || store.mtimeMs !== source.mtime_ms
    || store.ctimeMs !== source.ctime_ms
    || (Number(store.ino) || 0) !== source.ino) {
    deny("Companion policy projection is stale");
  }

  const canonicalProjects = new Set<string>();
  const projects = value.projects.map((entry) => {
    const project = validateProject(entry);
    // A deleted/offline unrelated project must not disable all companion use.
    // Keep its trusted absolute store path as a lexical policy root so future
    // intersections still fail closed; actual parent/target directories are
    // independently required to exist and canonicalize before authorization.
    const canonical = canonicalProjectedDirectory(project.cwd);
    if (canonicalProjects.has(canonical)) deny("Companion policy contains ambiguous project roots");
    canonicalProjects.add(canonical);
    return { ...project, cwd: canonical };
  });

  const sessionIds = new Set<string>();
  const sessionPaths = new Set<string>();
  const sessions = value.sessions.map((entry) => {
    const session = validateSession(entry);
    const normalizedPath = path.resolve(session.path);
    if (sessionIds.has(session.session_id) || sessionPaths.has(normalizedPath)) {
      deny("Companion policy contains ambiguous session identity mappings");
    }
    sessionIds.add(session.session_id);
    sessionPaths.add(normalizedPath);
    return { ...session, path: normalizedPath };
  });

  return {
    schema_version: 1,
    generation: value.generation as number,
    complete: true,
    source_store: source,
    projects,
    sessions,
  };
}

function projectForPath(
  projects: CompanionProjectPolicy[],
  target: string,
): CompanionProjectPolicy | undefined {
  return projects
    .filter((project) => pathIsWithin(target, project.cwd))
    .sort((a, b) => b.cwd.length - a.cwd.length)[0];
}

export function normalizeToolList(tools: readonly string[] | string | undefined): string[] {
  const values = typeof tools === "string" ? tools.split(",") : tools ?? [];
  return [...new Set(values.map((tool) => tool.trim()).filter(Boolean))].sort();
}

/**
 * Pi 0.74 exposes ExtensionAPI.getActiveTools() as string names, while newer
 * APIs/documentation may expose tool descriptors. Both represent the same
 * active ceiling; source metadata is not required to recover the names.
 */
export function activeToolNamesFromApi(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
      return (entry as { name: string }).name;
    }
    return "";
  });
  return normalizeToolList(names);
}

function canonicalSessionPath(candidate: string | undefined): string | null {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

export function resolveSourceAgentProfile(options: {
  projection: CompanionPolicyProjection;
  parentSessionId?: string;
  parentSessionFile?: string;
}): string | null {
  // The projection session_id is Wayang's stable row ID, while Pi's
  // SessionManager ID is a different namespace. The canonical Pi session file
  // is therefore the authoritative join key. Never accept an id-only match:
  // a standalone process could otherwise assert a copied Wayang row ID.
  const sessionFile = canonicalSessionPath(options.parentSessionFile);
  if (!sessionFile) return null;
  const matches = options.projection.sessions.filter((session) => {
    try { return fs.realpathSync.native(session.path) === sessionFile; }
    catch { return path.resolve(session.path) === sessionFile; }
  });
  if (matches.length > 1) deny("Companion policy parent session identity is ambiguous");
  return matches[0]?.agent_profile_id ?? null;
}

/**
 * Authorize a parent/target pair and derive a child tool ceiling. Missing,
 * stale, malformed, contradictory, unknown, and protected decisions all deny.
 */
export function authorizeSubagentLaunch(options: {
  parentCwd: string;
  targetCwd: string;
  parentTools: readonly string[] | string | undefined;
  requestedTools?: readonly string[] | string;
  projectionPath?: string;
  parentSessionId?: string;
  parentSessionFile?: string;
  /** Trusted only after the parent runner derived it from the projection. */
  trustedSourceAgentProfileId?: string | null;
}): SubagentLaunchAuthorization {
  const projectionPath = options.projectionPath ?? companionPolicyProjectionPath();
  const projection = loadCompanionPolicyProjection(projectionPath);
  const parent = canonicalExistingDirectory(path.resolve(options.parentCwd), "Subagent parent cwd");
  const target = canonicalExistingDirectory(path.resolve(options.targetCwd), "Subagent target cwd");
  const parentProject = projectForPath(projection.projects, parent);
  const targetProject = projectForPath(projection.projects, target);
  if (!parentProject) deny("Subagent parent project is unknown");
  if (!targetProject) deny("Subagent target project is unknown");
  if (!parentProject.subagents || parentProject.privacy_mode === "protected") {
    deny("Subagents are denied by the parent project policy");
  }
  if (!targetProject.subagents || targetProject.privacy_mode === "protected") {
    deny("Subagents are denied by the target project policy");
  }

  let sourceAgentProfileId: string | null;
  if (options.trustedSourceAgentProfileId !== undefined) {
    sourceAgentProfileId = options.trustedSourceAgentProfileId;
    if (sourceAgentProfileId !== null && !sourceAgentProfileId) {
      deny("Companion policy source agent profile is invalid");
    }
  } else {
    sourceAgentProfileId = resolveSourceAgentProfile({
      projection,
      parentSessionId: options.parentSessionId,
      parentSessionFile: options.parentSessionFile,
    });
  }
  for (const [label, project] of [["parent", parentProject], ["target", targetProject]] as const) {
    const allowlist = project.allowed_agent_profile_ids;
    if (!allowlist) continue;
    if (!sourceAgentProfileId) {
      deny(`Subagent source agent profile is unknown for the ${label} project allowlist`);
    }
    if (!allowlist.includes(sourceAgentProfileId)) {
      deny(`Subagent source agent profile is not allowed by the ${label} project`);
    }
  }

  const parentTools = normalizeToolList(options.parentTools);
  const requested = options.requestedTools === undefined
    ? parentTools
    : normalizeToolList(options.requestedTools);
  const parentToolSet = new Set(parentTools);
  const protectedProjectsPresent = projection.projects.some(
    (project) => project.privacy_mode === "protected" || !project.subagents,
  );
  // Wayang companion children are path-tool-only regardless of project mix.
  // Bash, sudo_exec, and extension/custom tools could bypass Standard
  // allowlists, transcript/control roots, or PIN protection.
  const effectiveTools = requested.filter((tool) => (
    parentToolSet.has(tool) && CHILD_SAFE_PATH_TOOL_SET.has(tool)
  ));

  return {
    generation: projection.generation,
    projectionPath,
    parentProjectCwd: parentProject.cwd,
    targetProjectCwd: targetProject.cwd,
    effectiveTools,
    allowPrivilegedExec: effectiveTools.includes("sudo_exec"),
    protectedProjectsPresent,
    sourceAgentProfileId,
  };
}

export interface ProjectionFreshnessRetryOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

function isTransientProjectionStaleness(error: unknown): boolean {
  return error instanceof CompanionPolicyDeniedError
    && error.message === "Companion policy projection is stale";
}

/**
 * Wait briefly for Wayang's atomic projection writer to catch up with a store
 * flush. Only the exact fingerprint-stale state is retryable; missing,
 * malformed, contradictory, unknown, or denied policy still fails immediately.
 */
export async function authorizeSubagentLaunchWithFreshProjection(
  options: Parameters<typeof authorizeSubagentLaunch>[0],
  retry: ProjectionFreshnessRetryOptions = {},
): Promise<SubagentLaunchAuthorization> {
  const timeoutMs = Math.max(0, Math.min(retry.timeoutMs ?? 500, 2_000));
  const intervalMs = Math.max(1, Math.min(retry.intervalMs ?? 25, 250));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return authorizeSubagentLaunch(options);
    } catch (error) {
      if (!isTransientProjectionStaleness(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

export function childPolicyGuardPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return process.env.MYPI_AGENT_TEAMS_CHILD_GUARD
    || path.join(agentDir, "extensions", "agent-teams", "child-policy-guard.ts");
}

export function validateChildPolicyGuardPath(candidate = childPolicyGuardPath()): string {
  if (!path.isAbsolute(candidate)) deny("Child policy guard path must be absolute");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(candidate); }
  catch { deny("Reviewed child policy guard is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink()) deny("Reviewed child policy guard must be a regular file");
  try { return fs.realpathSync.native(candidate); }
  catch { deny("Reviewed child policy guard cannot be resolved"); }
}

function canonicalizeChildToolTarget(
  rawTarget: string,
  cwd: string,
  forMutation: boolean,
): string {
  const absolute = path.resolve(cwd, rawTarget.trim().replace(/^@/, ""));
  try { return fs.realpathSync.native(absolute); }
  catch {
    if (!forMutation) deny("Child path target is unavailable");
  }

  const missing: string[] = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        deny("Child mutation target contains an unresolved symlink");
      }
    } catch (error) {
      if (error instanceof CompanionPolicyDeniedError) throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) deny("Child mutation target has no existing parent");
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  let parentReal: string;
  try { parentReal = fs.realpathSync.native(cursor); }
  catch { deny("Child mutation parent cannot be resolved"); }
  return path.join(parentReal, ...missing);
}

function canonicalPotentialPath(target: string): string {
  try { return fs.realpathSync.native(target); }
  catch { return canonicalizeChildToolTarget(target, "/", true); }
}

export function commandGuardPinPaths(): string[] {
  const defaultConfigHome = path.join(os.homedir(), ".config");
  const configuredConfigHome = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : defaultConfigHome;
  return [...new Set([defaultConfigHome, configuredConfigHome].map((configHome) => (
    canonicalPotentialPath(path.join(configHome, "pi", COMMAND_GUARD_PIN_FILENAME))
  )))];
}

function canonicalChildArtifactRoots(
  projectionPath: string,
  projection: CompanionPolicyProjection,
): string[] {
  const configured = (process.env.WAYANG_CONTROL_PATHS || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    || path.join(os.homedir(), ".pi", "agent");
  const configuredSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  const transcriptPaths = projection.sessions.flatMap((session) => [session.path, path.dirname(session.path)]);
  const roots = [
    path.dirname(projectionPath),
    path.join(path.resolve(agentDir), "sessions"),
    ...(configuredSessionDir ? [path.resolve(configuredSessionDir)] : []),
    LEGACY_ATTACHMENT_ROOT,
    ...transcriptPaths,
    ...configured,
  ];
  return [...new Set(roots.map((root) => {
    const absolute = path.resolve(root);
    try { return fs.realpathSync.native(absolute); }
    catch { return absolute; }
  }))];
}

export interface ChildPathAuthorization {
  generation: number;
  canonicalPath: string;
}

/** Reload and enforce the live projection for one built-in child path tool. */
export function authorizeChildPathToolCall(options: {
  cwd: string;
  toolName: string;
  input: unknown;
  projectionPath?: string;
  sourceAgentProfileId?: string | null;
}): ChildPathAuthorization {
  if (!CHILD_SAFE_PATH_TOOL_SET.has(options.toolName)) deny("Child tool is not a reviewed path tool");
  const projectionPath = options.projectionPath
    || process.env.MYPI_COMPANION_POLICY_PROJECTION
    || companionPolicyProjectionPath();
  const projection = loadCompanionPolicyProjection(projectionPath);
  const cwd = canonicalExistingDirectory(path.resolve(options.cwd), "Child cwd");
  const targetProject = projectForPath(projection.projects, cwd);
  if (!targetProject || targetProject.privacy_mode !== "standard" || !targetProject.subagents) {
    deny("Child target project is no longer authorized for subagents");
  }

  const input = options.input as Record<string, unknown> | undefined;
  const rawPath = typeof input?.path === "string" && input.path.trim() ? input.path : cwd;
  const forMutation = options.toolName === "write" || options.toolName === "edit";
  const canonicalPath = canonicalizeChildToolTarget(rawPath, cwd, forMutation);
  const traverses = CHILD_RECURSIVE_PATH_TOOLS.has(options.toolName);
  const intersects = (root: string): boolean => (
    pathIsWithin(canonicalPath, root) || (!forMutation && traverses && pathIsWithin(root, canonicalPath))
  );

  for (const project of projection.projects) {
    if (!intersects(project.cwd)) continue;
    if (project.privacy_mode === "protected" || !project.subagents) {
      deny("Child path access to a protected project is denied");
    }
    const allowlist = project.allowed_agent_profile_ids;
    if (allowlist && (!options.sourceAgentProfileId || !allowlist.includes(options.sourceAgentProfileId))) {
      deny("Child path access is denied by the Standard project agent allowlist");
    }
  }
  for (const pinPath of commandGuardPinPaths()) {
    if (intersects(pinPath)) {
      deny("Child path access to command-guard identity PIN storage is denied");
    }
  }
  for (const artifactRoot of canonicalChildArtifactRoots(projectionPath, projection)) {
    if (intersects(artifactRoot)) {
      deny("Child path access to transcript/attachment/Wayang control storage is denied");
    }
  }
  return { generation: projection.generation, canonicalPath };
}

export function companionPolicyEnvironment(
  authorization: SubagentLaunchAuthorization,
): NodeJS.ProcessEnv {
  return {
    MYPI_COMPANION_POLICY_GENERATION: String(authorization.generation),
    MYPI_COMPANION_PARENT_PROJECT_CWD: authorization.parentProjectCwd,
    MYPI_COMPANION_TARGET_PROJECT_CWD: authorization.targetProjectCwd,
    MYPI_COMPANION_ALLOWED_TOOLS: authorization.effectiveTools.join(","),
    MYPI_COMPANION_POLICY_PROJECTION: authorization.projectionPath,
    MYPI_COMPANION_PROTECTED_PROJECTS_PRESENT: authorization.protectedProjectsPresent ? "1" : "0",
    ...(authorization.sourceAgentProfileId
      ? { MYPI_COMPANION_SOURCE_AGENT_PROFILE_ID: authorization.sourceAgentProfileId }
      : {}),
  };
}

/** Build child env without ever reading excluded command-guard PIN values. */
export function sanitizedChildProcessEnvironment(
  authorization: SubagentLaunchAuthorization,
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(parentEnvironment)) {
    if (COMMAND_GUARD_PIN_ENV_RE.test(key)) continue;
    environment[key] = parentEnvironment[key];
  }
  return { ...environment, ...companionPolicyEnvironment(authorization) };
}

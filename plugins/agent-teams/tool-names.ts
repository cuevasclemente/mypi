/**
 * The complete model-callable Agent Teams surface.
 *
 * Keep every current/future subagent, goal, coordination, and team tool in this
 * one list so a fail-closed companion-policy decision cannot leave a stale
 * Agent Teams capability active.
 */
export const AGENT_TEAMS_TOOL_NAMES = Object.freeze([
  "subagent_spawn",
  "subagent_send",
  "subagent_poll",
  "subagent_stop",
  "subagent_list",
  "subagent_dispatch",
  "goals_list",
  "goals_add",
  "goals_check",
  "goals_update",
  "goals_remove",
] as const);

export const AGENT_TEAMS_TOOL_NAME_SET: ReadonlySet<string> = new Set(AGENT_TEAMS_TOOL_NAMES);

export function withoutAgentTeamsTools(activeToolNames: readonly string[]): string[] {
  return activeToolNames.filter((name) => !AGENT_TEAMS_TOOL_NAME_SET.has(name));
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CHILD_SAFE_PATH_TOOLS,
  authorizeChildPathToolCall,
  authorizeSubagentLaunch,
} from "./companion-policy.js";

const PATH_TOOLS = new Set<string>(CHILD_SAFE_PATH_TOOLS);

function liveLineageAuthorization() {
  const parentCwd = process.env.MYPI_COMPANION_PARENT_PROJECT_CWD;
  const targetCwd = process.env.MYPI_COMPANION_TARGET_PROJECT_CWD;
  const projectionPath = process.env.MYPI_COMPANION_POLICY_PROJECTION;
  if (!parentCwd || !targetCwd || !projectionPath) {
    throw new Error("Child companion policy context is unavailable");
  }
  return authorizeSubagentLaunch({
    parentCwd,
    targetCwd,
    parentTools: [],
    requestedTools: [],
    projectionPath,
    trustedSourceAgentProfileId: process.env.MYPI_COMPANION_SOURCE_AGENT_PROFILE_ID || null,
  });
}

/**
 * The sole explicitly loaded child extension. General extension discovery is
 * disabled by the process runners, so no later extension can mutate path args
 * after this live fail-closed check.
 */
export default function childPolicyGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    try {
      const lineage = liveLineageAuthorization();
      if (PATH_TOOLS.has(event.toolName)) {
        authorizeChildPathToolCall({
          cwd: ctx.cwd,
          toolName: event.toolName,
          input: event.input,
          projectionPath: lineage.projectionPath,
          sourceAgentProfileId: lineage.sourceAgentProfileId,
        });
        return;
      }
      return {
        block: true,
        reason: "Child companion policy permits only reviewed built-in path tools",
      };
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : "Child companion policy denied the tool call",
      };
    }
  });
}

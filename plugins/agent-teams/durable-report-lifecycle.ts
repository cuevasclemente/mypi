import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentManager } from "./subagent-manager.js";
import {
  createDurableSubagentReport,
  formatDurableSubagentReports,
  pendingDurableSubagentReports,
  SUBAGENT_REPORT_ENTRY_TYPE,
  SUBAGENT_REPORT_MESSAGE_TYPE,
} from "./durable-reports.ts";

/**
 * Install the durable final-report lifecycle independently of tool/UI setup so
 * append, recovery, once-only delivery, and branch teardown can be exercised
 * with a synthetic ExtensionAPI harness.
 */
export function installDurableSubagentReportLifecycle(
  pi: Pick<ExtensionAPI, "appendEntry" | "on">,
  subagentManager: Pick<SubagentManager, "setNotifyHandler" | "stopAll">,
): void {
  // Persist every bounded final report on the exact current session branch.
  // Do not also use Pi's process-local nextTurn queue: it survives extension
  // reload and tree navigation without branch ownership, which can duplicate
  // or leak a branch-A report into branch B. before_agent_start recovers the
  // durable entry and the resulting custom message is its delivery marker.
  subagentManager.setNotifyHandler((agentId, content) => {
    try {
      const report = createDurableSubagentReport(agentId, content);
      pi.appendEntry(SUBAGENT_REPORT_ENTRY_TYPE, report);
    } catch {
      // Session shutdown can make appendEntry unavailable. Never fall back to
      // an unbounded queue, filesystem, or log containing the report.
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const reports = pendingDurableSubagentReports(ctx.sessionManager.getBranch());
    if (reports.length === 0) return;
    return {
      message: {
        customType: SUBAGENT_REPORT_MESSAGE_TYPE,
        content: formatDurableSubagentReports(reports),
        display: true,
        details: { durableReportIds: reports.map((report) => report.reportId) },
      },
    };
  });

  // A child completion is appended to the current parent leaf. Stop all
  // children before tree navigation so a report spawned on branch A can never
  // race completion onto branch B. New/resume/fork/reload already pass through
  // the extension's session_shutdown complete teardown.
  pi.on("session_before_tree", async () => {
    await subagentManager.stopAll();
  });
}

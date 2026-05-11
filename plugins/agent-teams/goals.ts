/**
 * Goals module - Long-horizon goal tracking for agent teams
 *
 * Goals are either:
 *   - Programmatic: Define a bash command (checkCommand) that, when
 *     running successfully (exit 0), indicates the goal is met.
 *   - Qualitative: No checkCommand; the team evaluates progress
 *     against the goal description.
 *
 * Goals are stored in the session as custom entries and auto-checked
 * between task dispatches.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface Goal {
  id: string;
  description: string;
  /** Bash command to check if goal is met (exit 0 = met) */
  checkCommand?: string;
  /** Qualitative progress notes */
  progress?: string;
  /** Whether the goal is completed */
  completed: boolean;
  /** When the goal was created */
  createdAt: number;
  /** When the goal was completed */
  completedAt?: number;
}

export interface GoalDefinition {
  id: string;
  description: string;
  checkCommand?: string;
}

/** Goal definitions can be loaded from .pi/goals/*.md files */
export interface GoalFile {
  path: string;
  definitions: GoalDefinition[];
}

function loadGoalsFromDir(dir: string): GoalDefinition[] {
  const definitions: GoalDefinition[] = [];
  if (!fs.existsSync(dir)) return definitions;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return definitions;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const parsed = parseFrontmatter<Record<string, string>>(content);
    const fm = parsed.frontmatter;
    const id = fm.id || entry.name.replace(/\.md$/, "");
    const description = fm.description || parsed.body?.trim() || id;
    const checkCommand = fm.check;

    if (description) {
      definitions.push({ id, description, checkCommand });
    }
  }

  return definitions;
}

/** Create a Goal from a GoalDefinition */
export function createGoal(def: GoalDefinition): Goal {
  return {
    id: def.id,
    description: def.description,
    checkCommand: def.checkCommand,
    completed: false,
    createdAt: Date.now(),
  };
}

/** Format goals for inclusion in orchestrator prompt */
export function formatGoalsForPrompt(goals: Goal[]): string {
  if (goals.length === 0) return "(no active goals)";

  return goals
    .map((g, i) => {
      const status = g.completed ? "✓ COMPLETED" : "○ IN PROGRESS";
      const type = g.checkCommand ? `(check: \`${g.checkCommand}\`)` : "(qualitative)";
      const progress = g.progress ? ` | Progress: ${g.progress}` : "";
      return `${i + 1}. ${g.description} [${status}] ${type}${progress}`;
    })
    .join("\n");
}

/** Check all goals that have programmatic check commands */
export async function checkGoals(
  goals: Goal[],
  cwd: string,
  execFn: (command: string, cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<Goal[]> {
  const updated = goals.map((g) => ({ ...g }));
  for (const goal of updated) {
    if (goal.completed || !goal.checkCommand) continue;
    try {
      const result = await execFn(goal.checkCommand, cwd);
      if (result.exitCode === 0) {
        goal.completed = true;
        goal.completedAt = Date.now();
        goal.progress = `Goal met: ${result.stdout.trim() || "(check passed)"}`;
      }
    } catch {
      // Check failed, goal not yet met
    }
  }
  return updated;
}

/**
 * Team discovery and configuration
 *
 * Teams are defined in .pi/teams/*.md files with YAML frontmatter:
 *   ---
 *   name: full-stack
 *   description: Full-stack development team
 *   agents: frontend, backend, database
 *   orchestrator: architect
 *   ---
 *   Optional team-level system prompt context...
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import type { Goal } from "./goals.js";

export interface TeamConfig {
  name: string;
  description: string;
  /** Agent names that are part of this team */
  agents: string[];
  /** Orchestrator agent name (must resolve to an agent) */
  orchestrator: string;
  /** Optional: Max parallel agent dispatches */
  maxParallel?: number;
  /** Optional: Team-level system prompt context */
  teamPrompt?: string;
  /** Source location */
  source: "user" | "project";
  filePath: string;
}

export interface TeamDiscoveryResult {
  teams: TeamConfig[];
  projectTeamsDir: string | null;
}

function loadTeamsFromDir(dir: string, source: "user" | "project"): TeamConfig[] {
  const teams: TeamConfig[] = [];
  if (!fs.existsSync(dir)) return teams;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return teams;
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
    if (!fm.name || !fm.description || !fm.agents) continue;

    const agentList = fm.agents
      .split(",")
      .map((a: string) => a.trim())
      .filter(Boolean);

    if (agentList.length === 0) continue;

    teams.push({
      name: fm.name,
      description: fm.description,
      agents: agentList,
      orchestrator: fm.orchestrator || "architect",
      maxParallel: fm.maxParallel ? parseInt(fm.maxParallel, 10) || undefined : undefined,
      teamPrompt: parsed.body?.trim() || undefined,
      source,
      filePath,
    });
  }

  return teams;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectTeamsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "teams");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export type TeamScope = "user" | "project" | "both";

export function discoverTeams(cwd: string, scope: TeamScope): TeamDiscoveryResult {
  const userDir = path.join(getAgentDir(), "teams");
  const projectTeamsDir = findNearestProjectTeamsDir(cwd);

  const userTeams = scope === "project" ? [] : loadTeamsFromDir(userDir, "user");
  const projectTeams = scope === "user" || !projectTeamsDir ? [] : loadTeamsFromDir(projectTeamsDir, "project");

  const teamMap = new Map<string, TeamConfig>();
  if (scope === "both") {
    for (const team of userTeams) teamMap.set(team.name, team);
    for (const team of projectTeams) teamMap.set(team.name, team);
  } else if (scope === "user") {
    for (const team of userTeams) teamMap.set(team.name, team);
  } else {
    for (const team of projectTeams) teamMap.set(team.name, team);
  }

  return { teams: Array.from(teamMap.values()), projectTeamsDir };
}

/** Build orchestration system prompt enriched with team and goal context */
export function buildTeamSystemPrompt(
  team: TeamConfig,
  agents: AgentConfig[],
  goals: Goal[],
  task: string,
): string {
  const teamMembers = team.agents
    .map((name) => {
      const agent = agents.find((a) => a.name === name);
      if (!agent) return `- **${name}**: (agent definition not found)`;
      const toolsStr = agent.tools?.join(", ") || "all default pi tools";
      return `- **${name}** (model: ${agent.model || "default"}): ${agent.description}\n  Tools: ${toolsStr}`;
    })
    .join("\n");

  const goalsBlock =
    goals.length > 0
      ? goals
          .map((g, i) => {
            const status = g.completed ? "✓ COMPLETED" : "○ IN PROGRESS";
            const type = g.checkCommand ? `(check: \`${g.checkCommand}\`)` : "(qualitative)";
            return `**Goal ${i + 1}**: ${g.description} [${status}] ${type}`;
          })
          .join("\n")
      : "(no active goals)";

  return `You are the **orchestrator** for the "${team.name}" team.

## Your Role
${team.description}

## Team Members
${teamMembers}

## Active Goals
${goalsBlock}

## Task
${task}

## How to Operate

1. **Analyze** the task and determine which team members need to contribute.
2. **Create a dispatch plan** using the \`subagent\` tool. Each dispatch should be a focused task for a specific team member.
3. **Dispatch in parallel** when tasks are independent. Use sequential chain mode when one task depends on another.
4. **Review results** and ensure they meet the goals.

When writing your response:

### Dispatch Plan
List which agents need to do what:
- agent: <name> | task: <specific task description>

Then use the \`subagent\` tool to execute.

### Synthesis
After receiving subagent results, summarize what was accomplished and what remains.
Reference active goals and indicate progress.

Start by analyzing the task and creating a dispatch plan.`;
}

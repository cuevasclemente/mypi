import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EmbeddingClient } from "./embed-client.js";
import { readProjectPins, rewriteSkillCatalog, type PromptSkill } from "./prompt.js";
import { readBoundedRegularFile } from "./safe-file.js";
import { fuseSearchResults, lexicalSearch, type SearchSkill } from "./search.js";

const MAX_SKILL_BYTES = 36 * 1024;
const MAX_SKILL_LINES = 1500;
const MAX_TOOL_OUTPUT_BYTES = 48 * 1024;
const MAX_TOOL_OUTPUT_LINES = 1800;
const disabled = /^(0|false|no|off)$/i.test(process.env.PI_PROGRESSIVE_SKILLS ?? "");

function visibleSkills(skills: PromptSkill[], projectTrusted: boolean): SearchSkill[] {
	return skills
		.filter((skill) => !skill.disableModelInvocation)
		.filter((skill) => skill.sourceInfo?.scope !== "project" || projectTrusted)
		.map(({ name, description, filePath, baseDir, sourceInfo }) => ({
			name,
			description,
			filePath,
			baseDir,
			scope: sourceInfo?.scope,
		}));
}

function loadSkillBody(skill: SearchSkill): { text?: string; error?: string; bytes?: number } {
	const result = readBoundedRegularFile(skill.filePath, skill.baseDir, MAX_SKILL_BYTES);
	if (result.text && result.text.split(/\r?\n/).length > MAX_SKILL_LINES) {
		return { error: `Skill contains more than ${MAX_SKILL_LINES} lines; use the read tool on the reviewed location instead.`, bytes: result.bytes };
	}
	return result;
}

function validateToolOutput(text: string): boolean {
	return Buffer.byteLength(text, "utf8") <= MAX_TOOL_OUTPUT_BYTES
		&& text.split(/\r?\n/).length <= MAX_TOOL_OUTPUT_LINES;
}

function displayDescription(description: string): string {
	return description.length <= 500 ? description : `${description.slice(0, 499)}…`;
}

interface SkillSearchDetails {
	mode: string;
	matches: Array<{ name: string; score: number }>;
	loaded: string | null;
}

const skillSearchParameters = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 500, description: "Short task or capability description; omit private details that are irrelevant to routing" }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 5 })),
	load_best: Type.Optional(Type.Boolean({ default: false, description: "Also load the highest-ranked skill instructions in this result" })),
});

export default function progressiveSkills(pi: ExtensionAPI) {
	let catalog: SearchSkill[] = [];
	let promptChanged = false;
	let removedChars = 0;
	let pinErrors: string[] = [];
	const embeddings = new EmbeddingClient();

	pi.registerTool<typeof skillSearchParameters, SkillSearchDetails>({
		name: "skill_search",
		label: "Search Skills",
		description: "Search local specialized agent skills by task or capability using hybrid semantic and lexical retrieval. Use before unfamiliar, specialized, operational, or safety-sensitive work because the global skill catalog is intentionally omitted from the initial prompt.",
		promptSnippet: "Search local specialized procedures omitted from the initial prompt",
		promptGuidelines: [
			"Use skill_search before specialized, unfamiliar, operational, or safety-sensitive work; use skill_load before acting on a selected result.",
		],
		parameters: skillSearchParameters,
		async execute(_toolCallId, params, signal) {
			signal?.throwIfAborted();
			const limit = params.limit ?? 5;
			if (catalog.length === 0) {
				return { content: [{ type: "text", text: "No model-invokable skills are available." }], details: { matches: [], mode: "empty", loaded: null } };
			}
			const lexical = lexicalSearch(catalog, params.query, 20);
			let dense: Array<{ name: string; score: number }> = [];
			let mode = "lexical";
			try {
				dense = await embeddings.search(catalog, params.query, 20, signal);
				if (dense.length > 0) mode = "hybrid";
			} catch (error) {
				if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
				dense = [];
			}
			const matches = fuseSearchResults(catalog, lexical, dense, params.query, limit);
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: "No skills matched the requested capability. Try a more specific task description if specialized guidance still seems likely." }],
					details: { matches: [], mode, loaded: null },
				};
			}
			const lines = [`Skill search (${mode}):`];
			for (const [index, match] of matches.entries()) {
				lines.push(`${index + 1}. ${match.name} — ${displayDescription(match.description)}\n   ${match.filePath}`);
			}
			signal?.throwIfAborted();
			let loaded: string | undefined;
			if (params.load_best) {
				const result = loadSkillBody(matches[0]);
				if (result.text) {
					const candidate = [...lines, `\nLoaded skill: ${matches[0].name}\n\n${result.text}`].join("\n");
					if (validateToolOutput(candidate)) {
						loaded = matches[0].name;
						lines.push(`\nLoaded skill: ${matches[0].name}\n\n${result.text}`);
					} else {
						lines.push(`\nBest match ${matches[0].name} was not inlined because the combined result would exceed the tool-output budget; call skill_load with that exact name.`);
					}
				} else {
					lines.push(`\nCould not load ${matches[0].name}: ${result.error}`);
				}
			}
			signal?.throwIfAborted();
			const output = lines.join("\n");
			if (!validateToolOutput(output)) throw new Error("Skill search result exceeds the tool-output budget.");
			return {
				content: [{ type: "text", text: output }],
				details: { mode, matches: matches.map(({ name, score }) => ({ name, score })), loaded: loaded ?? null },
			};
		},
	});

	pi.registerTool({
		name: "skill_load",
		label: "Load Skill",
		description: "Load one exact local skill returned by skill_search. The name must match the current discovered-skill catalog; arbitrary paths are never accepted.",
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
		}),
		async execute(_toolCallId, params, signal) {
			signal?.throwIfAborted();
			const skill = catalog.find((candidate) => candidate.name === params.name);
			if (!skill) throw new Error(`Unknown or user-only skill: ${params.name}`);
			const result = loadSkillBody(skill);
			if (!result.text) throw new Error(result.error ?? "Skill could not be loaded.");
			signal?.throwIfAborted();
			const output = `Loaded skill ${skill.name} from ${skill.filePath}:\n\n${result.text}`;
			if (!validateToolOutput(output)) throw new Error("Loaded skill exceeds the tool-output budget.");
			return {
				content: [{ type: "text", text: output }],
				details: { name: skill.name, filePath: skill.filePath, bytes: result.bytes },
			};
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (disabled) return;
		const options = (event as { systemPromptOptions?: { skills?: PromptSkill[] } }).systemPromptOptions;
		if (!options) return;
		const trustFunction = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted;
		const projectTrusted = typeof trustFunction === "function" ? trustFunction.call(ctx) : false;
		const skills = options.skills ?? [];
		catalog = visibleSkills(skills, projectTrusted);
		const pinResult = readProjectPins(ctx.cwd, projectTrusted, skills, ".pi");
		pinErrors = pinResult.errors;
		const rewritten = rewriteSkillCatalog(event.systemPrompt, skills, pinResult.pins);
		promptChanged = rewritten.changed;
		removedChars = rewritten.removedChars;
		if (!rewritten.changed && catalog.length > 0) {
			ctx.ui.setStatus("progressive-skills", "skill catalog preserved (format mismatch)");
			return;
		}
		ctx.ui.setStatus("progressive-skills", `skills on demand (${catalog.length}${pinResult.pins.length ? `, ${pinResult.pins.length} pinned` : ""})`);
		return { systemPrompt: rewritten.prompt };
	});

	pi.registerCommand("skills-status", {
		description: "Show progressive skill-disclosure status without prompt or query content",
		handler: async (_args, ctx) => {
			const message = disabled
				? "Progressive skills: disabled by PI_PROGRESSIVE_SKILLS."
				: `Progressive skills: ${promptChanged ? "active" : "not applied"}; searchable=${catalog.length}; removed_chars=${removedChars}; dense=${embeddings.available() ? "available" : "unavailable"}${pinErrors.length ? `; pin_errors=${pinErrors.join(" | ")}` : ""}`;
			ctx.ui.notify(message, pinErrors.length ? "warning" : "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await embeddings.stop();
	});
}

export { loadSkillBody, validateToolOutput, visibleSkills };

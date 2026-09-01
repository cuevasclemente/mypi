import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readBoundedRegularFile } from "./safe-file.js";

export interface PromptSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation: boolean;
	sourceInfo?: { scope?: string };
}

const MAX_PIN_FILE_BYTES = 16 * 1024;
const MAX_PINS = 5;

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function formatNativeSkillBlock(skills: PromptSkill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export function formatDiscoveryBlock(pins: PromptSkill[]): string {
	const lines = [
		"\n\nSpecialized skills are stored locally in global and trusted-project skill directories and are intentionally omitted from this initial prompt.",
		"- Use skill_search before specialized, unfamiliar, or safety-sensitive work to find relevant procedures.",
		"- Use skill_load before acting on a selected skill; search results and project pins are descriptions, not loaded instructions.",
		"- If the exact name is already known, /skill:name remains available for explicit invocation.",
		"- When a loaded skill references a relative path, resolve it against that skill's directory.",
	];
	if (pins.length > 0) {
		lines.push("", "<project_pinned_skills>");
		for (const skill of pins) {
			lines.push("  <skill>");
			lines.push(`    <name>${escapeXml(skill.name)}</name>`);
			lines.push(`    <description>${escapeXml(skill.description)}</description>`);
			lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
			lines.push("  </skill>");
		}
		lines.push("</project_pinned_skills>");
	}
	return lines.join("\n");
}

export function rewriteSkillCatalog(
	systemPrompt: string,
	skills: PromptSkill[],
	pins: PromptSkill[],
): { prompt: string; changed: boolean; removedChars: number } {
	const nativeBlock = formatNativeSkillBlock(skills);
	if (!nativeBlock) return { prompt: systemPrompt, changed: false, removedChars: 0 };
	const index = systemPrompt.indexOf(nativeBlock);
	if (index < 0 || systemPrompt.indexOf(nativeBlock, index + nativeBlock.length) >= 0) {
		return { prompt: systemPrompt, changed: false, removedChars: 0 };
	}
	const replacement = formatDiscoveryBlock(pins);
	return {
		prompt: systemPrompt.slice(0, index) + replacement + systemPrompt.slice(index + nativeBlock.length),
		changed: true,
		removedChars: nativeBlock.length - replacement.length,
	};
}

export function readProjectPins(
	cwd: string,
	trusted: boolean,
	skills: PromptSkill[],
	configDirName = ".pi",
): { pins: PromptSkill[]; configured: string[]; errors: string[] } {
	if (!trusted) return { pins: [], configured: [], errors: [] };
	const configDir = join(cwd, configDirName);
	const path = join(configDir, "progressive-skills.json");
	try {
		const directory = lstatSync(configDir);
		if (directory.isSymbolicLink() || !directory.isDirectory()) {
			return { pins: [], configured: [], errors: ["Project .pi config root must be a regular non-symlink directory."] };
		}
		lstatSync(path);
	} catch {
		return { pins: [], configured: [], errors: [] };
	}
	const loaded = readBoundedRegularFile(path, configDir, MAX_PIN_FILE_BYTES);
	if (!loaded.text) {
		return { pins: [], configured: [], errors: [loaded.error ?? "Project skill-pin config could not be read safely."] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(loaded.text);
	} catch {
		return { pins: [], configured: [], errors: ["Project skill-pin config is not valid JSON."] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => key !== "pins")) {
		return { pins: [], configured: [], errors: ["Project skill-pin config must contain only a pins array."] };
	}
	const values = (parsed as { pins?: unknown }).pins;
	if (!Array.isArray(values) || values.length > MAX_PINS || values.some((value) => typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))) {
		return { pins: [], configured: [], errors: [`Project skill pins must be an array of at most ${MAX_PINS} valid skill names.`] };
	}
	const configured = [...new Set(values as string[])];
	const map = new Map(skills.filter((skill) => !skill.disableModelInvocation).map((skill) => [skill.name, skill]));
	const pins = configured.flatMap((name) => {
		const skill = map.get(name);
		return skill ? [skill] : [];
	});
	const missing = configured.filter((name) => !map.has(name));
	return {
		pins,
		configured,
		errors: missing.length > 0 ? [`Unknown or user-only project skill pins: ${missing.join(", ")}`] : [],
	};
}

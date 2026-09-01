/**
 * Narwhal-Horn Provider
 *
 * Registers the llama.cpp server running on the laptop "narwhal-horn" as a pi
 * provider. Exposes Qwen3.6-35B-A3B-Abliterated-Heretic-Q6_K under the clean
 * id "qwen3.6-35b-a3b-heretic".
 *
 * Same source runs on both narwhal-horn (loopback) and other LAN clients. LAN
 * endpoint selection prefers mDNS/router DNS and may use ~/.ssh/config or an
 * explicit NARWHAL_HORN_FALLBACK_URL when local discovery regresses.
 *
 * Key lives in ~/src/mypi/secure_data/narwhal_horn_key (0600). Override the
 * endpoint with NARWHAL_HORN_BASE_URL if needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const KEY_FILE = join(homedir(), "src/mypi/secure_data/narwhal_horn_key");
const SSH_CONFIG = join(homedir(), ".ssh/config");
const PROBE_TIMEOUT_MS = Number(process.env.NARWHAL_HORN_PROBE_TIMEOUT_MS ?? "750");

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function readSshHostName(): string | undefined {
	if (!existsSync(SSH_CONFIG)) return undefined;

	let inNarwhalBlock = false;
	for (const rawLine of readFileSync(SSH_CONFIG, "utf-8").split(/\r?\n/)) {
		const line = rawLine.replace(/#.*/, "").trim();
		if (!line) continue;

		const [key, ...valueParts] = line.split(/\s+/);
		const value = valueParts.join(" ");
		if (key.toLowerCase() === "host") {
			inNarwhalBlock = valueParts.includes("narwhal-horn");
			continue;
		}

		if (inNarwhalBlock && key.toLowerCase() === "hostname" && value) return value;
	}
}

function candidateBaseUrls(): string[] {
	const urls: string[] = [];

	if (hostname() === "narwhal-horn") urls.push("http://127.0.0.1:8090/v1");

	urls.push(
		"http://narwhal-horn.local:8090/v1",
		"http://narwhal-horn:8090/v1",
		"http://narwhal-horn.the-gateway:8090/v1",
	);

	const sshHostName = readSshHostName();
	if (sshHostName) urls.push(`http://${sshHostName}:8090/v1`);
	const fallback = process.env.NARWHAL_HORN_FALLBACK_URL;
	if (fallback) urls.push(fallback);

	return unique(urls.map(normalizeBaseUrl));
}

async function canReach(baseUrl: string): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}/models`, { signal: controller.signal });
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

async function resolveBaseUrl(): Promise<string> {
	const override = process.env.NARWHAL_HORN_BASE_URL;
	if (override) return normalizeBaseUrl(override);

	const candidates = candidateBaseUrls();
	const results = await Promise.all(candidates.map(async (url) => ({ url, ok: await canReach(url) })));
	const reachable = results.find((result) => result.ok);
	if (reachable) return reachable.url;

	// Keep the provider visible even when the laptop is offline. The request-time
	// error will show the preferred endpoint that failed.
	console.warn(`[narwhal-horn] no endpoint responded within ${PROBE_TIMEOUT_MS}ms; using ${candidates[0]}`);
	return candidates[0];
}

// Empty apiKey causes pi to silently drop the provider from --list-models, so
// fall back to a placeholder when the key file is missing — the auth failure
// then becomes visible at request time instead.
function readKey(): string {
	if (!existsSync(KEY_FILE)) return "missing-key-file-create-secure_data/narwhal_horn_key";
	return readFileSync(KEY_FILE, "utf-8").trim() || "empty-key-file";
}

export default async function narwhalHorn(pi: ExtensionAPI) {
	const apiKey = readKey();
	const baseUrl = await resolveBaseUrl();

	pi.registerProvider("narwhal-horn", {
		name: "Narwhal Horn (LAN)",
		baseUrl,
		apiKey,
		api: "openai-completions",
		models: [
			{
				id: "qwen3.6-35b-a3b-heretic",
				name: "Qwen 3.6 35B A3B Heretic (Q6_K, Vulkan)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
				compat: {
					// llama.cpp with --jinja respects chat_template_kwargs.enable_thinking
					// on this abliterated tune. /no_think tag does not work — confirmed
					// in the original setup journal.
					thinkingFormat: "qwen-chat-template",
					supportsDeveloperRole: false,
					maxTokensField: "max_tokens",
				},
			},
		],
	});
}

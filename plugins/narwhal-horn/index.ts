/**
 * Narwhal-Horn Provider
 *
 * Registers the Qwen3.8-Flash-Next llama.cpp server as the stable
 * `narwhal-horn` provider. Clients may connect directly to Narwhal-Horn or
 * through the Ruminant shared gateway without changing provider/model ids.
 *
 * Direct key: ~/src/mypi/secure_data/narwhal_horn_key
 * Ruminant client key: ~/src/mypi/secure_data/ruminant_key
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export type NarwhalHornRoute = "direct" | "ruminant";

const DIRECT_KEY_FILE = join(homedir(), "src/mypi/secure_data/narwhal_horn_key");
const RUMINANT_KEY_FILE = join(homedir(), "src/mypi/secure_data/ruminant_key");
const SSH_CONFIG = join(homedir(), ".ssh/config");
const PROBE_TIMEOUT_MS = Number(process.env.NARWHAL_HORN_PROBE_TIMEOUT_MS ?? "750");

export interface RouteCandidateOptions {
	hostName: string;
	directBaseUrl?: string;
	directFallbackUrl?: string;
	directSshHostName?: string;
	ruminantBaseUrl?: string;
}

export const SESSION_AFFINITY_COMPAT = {
	sendSessionAffinityHeaders: true,
	sessionAffinityFormat: "openai",
} as const;

export const QWEN38_MODEL_CONFIG = {
	id: "qwen3.8-flash-next",
	name: "Qwen 3.8 Flash Next (Unsloth IQ4_XS, ROCm/NVMe, native 262K)",
	reasoning: true,
	thinkingLevelMap: {
		minimal: null,
		low: "low",
		medium: "medium",
		high: null,
		xhigh: "xhigh",
		max: null,
	},
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// Use the model's native window. Extended YaRN allocation works but is not
	// operationally useful on this one-slot host at measured long-prefill speed.
	contextWindow: 262144,
	maxTokens: 32768,
	compat: {
		// Flash-Next's llama.cpp template accepts thinking toggles, preserved
		// reasoning, and the model's low/medium/xhigh effort values.
		thinkingFormat: "chat-template",
		chatTemplateKwargs: {
			enable_thinking: { $var: "thinking.enabled" },
			preserve_thinking: true,
			reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
		},
		supportsDeveloperRole: true,
		maxTokensField: "max_tokens",
		...SESSION_AFFINITY_COMPAT,
	},
};

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

/** Strictly parse the route contract. Only an absent value enables auto-selection. */
export function selectNarwhalHornRoute(
	explicitRoute: string | undefined,
	ruminantKeyExists: boolean,
): NarwhalHornRoute {
	if (explicitRoute === undefined) return ruminantKeyExists ? "ruminant" : "direct";
	if (explicitRoute === "direct" || explicitRoute === "ruminant") return explicitRoute;

	throw new Error(
		`[narwhal-horn] invalid NARWHAL_HORN_ROUTE=${JSON.stringify(explicitRoute)}; expected "direct" or "ruminant"`,
	);
}

/** Avoid even checking the Ruminant key when an explicit route was configured. */
export function detectNarwhalHornRoute(
	explicitRoute: string | undefined,
	ruminantKeyExists: () => boolean,
): NarwhalHornRoute {
	if (explicitRoute !== undefined) return selectNarwhalHornRoute(explicitRoute, false);
	return selectNarwhalHornRoute(undefined, ruminantKeyExists());
}

/** Build candidates for one route only; Ruminant candidates can never contain a direct fallback. */
export function routeCandidateBaseUrls(
	route: NarwhalHornRoute,
	options: RouteCandidateOptions,
): string[] {
	if (route === "ruminant") {
		if (options.ruminantBaseUrl) return [normalizeBaseUrl(options.ruminantBaseUrl)];

		const urls: string[] = [];
		if (options.hostName.toLowerCase() === "the-sceptre") urls.push("http://127.0.0.1:8055/v1");
		// Prefer the verified IPv4 LAN endpoint before mDNS. Some hosts can probe
		// the dual-stack mDNS name successfully but later OpenAI requests select an
		// unreachable IPv6 address and time out.
		urls.push(
			"http://192.168.50.225:8055/v1",
			"http://the-sceptre.local:8055/v1",
			"http://the-sceptre:8055/v1",
			"http://the-sceptre.the-gateway:8055/v1",
		);
		return unique(urls.map(normalizeBaseUrl));
	}

	// Preserve the direct override and discovery order exactly.
	if (options.directBaseUrl) return [normalizeBaseUrl(options.directBaseUrl)];

	const urls: string[] = [];
	if (options.hostName === "narwhal-horn") urls.push("http://127.0.0.1:8090/v1");
	urls.push(
		"http://narwhal-horn.local:8090/v1",
		"http://narwhal-horn:8090/v1",
		"http://narwhal-horn.the-gateway:8090/v1",
	);
	if (options.directSshHostName) urls.push(`http://${options.directSshHostName}:8090/v1`);
	if (options.directFallbackUrl) urls.push(options.directFallbackUrl);
	return unique(urls.map(normalizeBaseUrl));
}

export function isReachableHttpStatus(status: number): boolean {
	// An unauthenticated /models probe commonly returns 401 on a healthy endpoint.
	return status < 500;
}

/** Resolve only within the selected route and retain its first candidate on total probe failure. */
export async function resolveRouteCandidate(
	route: NarwhalHornRoute,
	candidates: string[],
	probe: (baseUrl: string) => Promise<boolean>,
	warn: (message: string) => void = console.warn,
	probeTimeoutMs = PROBE_TIMEOUT_MS,
): Promise<string> {
	if (candidates.length === 0) throw new Error(`[narwhal-horn] ${route} route has no endpoint candidates`);

	const results = await Promise.all(candidates.map(async (url) => ({ url, ok: await probe(url) })));
	const reachable = results.find((result) => result.ok);
	if (reachable) return reachable.url;

	warn(
		`[narwhal-horn] no ${route} endpoint responded within ${probeTimeoutMs}ms; using ${candidates[0]}`,
	);
	return candidates[0];
}

export interface RouteKeyReader {
	exists(path: string): boolean;
	read(path: string): string;
}

/** Read exactly one route's key, retaining visible request-time placeholder failures. */
export function readSelectedRouteKey(route: NarwhalHornRoute, reader: RouteKeyReader): string {
	const keyFile = route === "ruminant" ? RUMINANT_KEY_FILE : DIRECT_KEY_FILE;
	if (!reader.exists(keyFile)) {
		return route === "ruminant"
			? "missing-key-file-create-secure_data/ruminant_key"
			: "missing-key-file-create-secure_data/narwhal_horn_key";
	}
	return reader.read(keyFile).trim() || "empty-key-file";
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

async function canReach(baseUrl: string): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}/models`, { signal: controller.signal });
		return isReachableHttpStatus(response.status);
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

async function resolveBaseUrl(route: NarwhalHornRoute): Promise<string> {
	const override =
		route === "direct" ? process.env.NARWHAL_HORN_BASE_URL : process.env.RUMINANT_BASE_URL;
	// Explicit endpoint overrides preserve the current direct route's no-probe behavior.
	if (override) return normalizeBaseUrl(override);

	const candidates = routeCandidateBaseUrls(route, {
		hostName: hostname(),
		directFallbackUrl: route === "direct" ? process.env.NARWHAL_HORN_FALLBACK_URL : undefined,
		directSshHostName: route === "direct" ? readSshHostName() : undefined,
	});
	return resolveRouteCandidate(route, candidates, canReach);
}

function readKey(route: NarwhalHornRoute): string {
	return readSelectedRouteKey(route, {
		exists: existsSync,
		read: (path) => readFileSync(path, "utf-8"),
	});
}

export default async function narwhalHorn(pi: ExtensionAPI) {
	const route = detectNarwhalHornRoute(process.env.NARWHAL_HORN_ROUTE, () => existsSync(RUMINANT_KEY_FILE));
	const apiKey = readKey(route);
	const baseUrl = await resolveBaseUrl(route);

	pi.registerProvider("narwhal-horn", {
		name: route === "ruminant" ? "Narwhal Horn (Ruminant)" : "Narwhal Horn (LAN)",
		baseUrl,
		apiKey,
		api: "openai-completions",
		// This provider intentionally preserves patched Qwen metadata fields that may
		// precede the installed public ProviderModelConfig declaration.
		models: [QWEN38_MODEL_CONFIG as unknown as ProviderModelConfig],
	});
}

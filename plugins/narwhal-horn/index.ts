/**
 * Narwhal-Horn Provider
 *
 * Registers the llama.cpp server running on the laptop "narwhal-horn" as a pi
 * provider. Exposes Qwen3.6-35B-A3B-Abliterated-Heretic-Q6_K under the clean
 * id "qwen3.6-35b-a3b-heretic".
 *
 * Same source runs on both narwhal-horn (loopback) and sceptre (LAN). On
 * sceptre, this only works when narwhal-horn is on the same network.
 *
 * Key lives in ~/src/mypi/secure_data/narwhal_horn_key (0600). Override the
 * endpoint with NARWHAL_HORN_BASE_URL if needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const BASE_URL =
	process.env.NARWHAL_HORN_BASE_URL ??
	(hostname() === "narwhal-horn"
		? "http://127.0.0.1:8090/v1"
		: "http://narwhal-horn.local:8090/v1");
const KEY_FILE = join(homedir(), "src/mypi/secure_data/narwhal_horn_key");

// Empty apiKey causes pi to silently drop the provider from --list-models, so
// fall back to a placeholder when the key file is missing — the auth failure
// then becomes visible at request time instead.
function readKey(): string {
	if (!existsSync(KEY_FILE)) return "missing-key-file-create-secure_data/narwhal_horn_key";
	return readFileSync(KEY_FILE, "utf-8").trim() || "empty-key-file";
}

export default function narwhalHorn(pi: ExtensionAPI) {
	const apiKey = readKey();

	pi.registerProvider("narwhal-horn", {
		name: "Narwhal Horn (LAN)",
		baseUrl: BASE_URL,
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

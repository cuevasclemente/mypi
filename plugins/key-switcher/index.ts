/**
 * OpenRouter Key Switcher Extension
 *
 * Switches the active OpenRouter API key between the standard key and the ZDR
 * (Zero Data Retention) key. Both keys live in ~/src/mypi/secure_data/ and
 * are never modified by this extension. The active key is written to
 * ~/.pi/agent/auth.json (which pi's AuthStorage reads on session start).
 *
 * Commands:
 *   /or-key           — show current mode and usage
 *   /or-key default   — switch to standard OpenRouter key
 *   /or-key zdr       — switch to ZDR OpenRouter key
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECURE_DATA = join(homedir(), "src/mypi/secure_data");
const MODE_FILE = join(homedir(), ".pi/openrouter-key-mode");
const AUTH_JSON = join(homedir(), ".pi/agent/auth.json");

const KEY_FILES: Record<Mode, string> = {
	default: join(SECURE_DATA, "openrouter_key"),
	zdr: join(SECURE_DATA, "zdr_openrouter_key"),
};

type Mode = "default" | "zdr";

function readMode(): Mode {
	if (!existsSync(MODE_FILE)) return "default";
	const val = readFileSync(MODE_FILE, "utf-8").trim();
	return val === "zdr" ? "zdr" : "default";
}

function readKey(mode: Mode): string {
	const keyPath = KEY_FILES[mode];
	if (!existsSync(keyPath)) {
		throw new Error(`Key file not found: ${keyPath}`);
	}
	const key = readFileSync(keyPath, "utf-8").trim();
	if (!key) throw new Error(`Key file is empty: ${keyPath}`);
	return key;
}

function writeAuth(key: string): void {
	let data: Record<string, unknown> = {};
	if (existsSync(AUTH_JSON)) {
		try {
			data = JSON.parse(readFileSync(AUTH_JSON, "utf-8"));
		} catch {
			data = {};
		}
	}
	data.openrouter = { type: "api_key", key };
	writeFileSync(AUTH_JSON, JSON.stringify(data, null, 2), "utf-8");
	chmodSync(AUTH_JSON, 0o600);
}

function applyMode(mode: Mode): void {
	const key = readKey(mode);
	writeAuth(key);
	writeFileSync(MODE_FILE, mode, "utf-8");
}

function modeLabel(mode: Mode): string {
	return mode === "zdr" ? "ZDR (Zero Data Retention)" : "default";
}

export default function keySwitcher(pi: ExtensionAPI) {
	pi.registerCommand("or-key", {
		description: "Switch active OpenRouter API key (default ↔ ZDR)",
		handler: async (args, ctx) => {
			const target = args?.trim().toLowerCase();

			if (!target) {
				const current = readMode();
				ctx.ui.notify(
					`OpenRouter key: ${modeLabel(current)}. ` +
						`Use "/or-key default" or "/or-key zdr" to switch.`,
					"info",
				);
				return;
			}

			if (target !== "default" && target !== "zdr") {
				ctx.ui.notify(
					`Unknown mode "${target}". Use "default" or "zdr".`,
					"warning",
				);
				return;
			}

			const current = readMode();
			if (current === target) {
				ctx.ui.notify(`Already using ${modeLabel(target)} key.`, "info");
				return;
			}

			try {
				applyMode(target);
			} catch (err) {
				ctx.ui.notify(`Failed to switch key: ${(err as Error).message}`, "error");
				return;
			}

			ctx.ui.notify(
				`Switched to ${modeLabel(target)} OpenRouter key. ` +
					`Restart the session for the change to take effect.`,
				"info",
			);
		},
	});
}

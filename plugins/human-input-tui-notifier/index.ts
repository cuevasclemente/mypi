import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The dependency-free module keeps notification policy independently testable.
// @ts-ignore This local JavaScript module intentionally has no runtime type dependency.
import { registerHumanInputNotifier } from "./notifier.mjs";

export default function humanInputTuiNotifier(pi: ExtensionAPI) {
	registerHumanInputNotifier(pi, process);
}

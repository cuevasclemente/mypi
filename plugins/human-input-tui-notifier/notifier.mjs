const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_BODY = "Needs your input";
const MAX_SEEN_GATE_IDS = 256;
const TYPED_GATE_TOOLS = new Set(["interview", "questionnaire"]);

function notificationSequence(env) {
	if (env?.KITTY_WINDOW_ID) {
		return `\x1b]99;i=pi-human-input:d=0;${NOTIFICATION_TITLE}\x1b\\` +
			`\x1b]99;i=pi-human-input:p=body;${NOTIFICATION_BODY}\x1b\\`;
	}
	return `\x1b]777;notify;${NOTIFICATION_TITLE};${NOTIFICATION_BODY}\x07`;
}

function writeNotification(runtime) {
	try {
		runtime.stdout.write(notificationSequence(runtime.env));
		return true;
	} catch {
		// Desktop notification failure must never affect the input gate.
		return false;
	}
}

function createBoundedGateIds(limit = MAX_SEEN_GATE_IDS) {
	const ids = new Set();
	const order = [];

	return {
		remember(id) {
			if (typeof id !== "string" || id.length === 0 || ids.has(id)) return false;
			ids.add(id);
			order.push(id);
			while (order.length > limit) {
				ids.delete(order.shift());
			}
			return true;
		},
	};
}

function registerHumanInputNotifier(pi, runtime) {
	const seenGateIds = createBoundedGateIds();

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui" || !TYPED_GATE_TOOLS.has(event.toolName)) return;
		if (!seenGateIds.remember(event.toolCallId)) return;
		writeNotification(runtime);
	});
}

export {
	MAX_SEEN_GATE_IDS,
	NOTIFICATION_BODY,
	NOTIFICATION_TITLE,
	createBoundedGateIds,
	notificationSequence,
	registerHumanInputNotifier,
	writeNotification,
};

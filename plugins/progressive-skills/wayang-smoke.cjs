#!/usr/bin/env node
/** Create one disposable Wayang session and verify installed progressive-skill tools. */
const crypto = require("node:crypto");
const { WebSocket } = require("/home/clemente/src/wayang/backend/node_modules/ws");
const HTTP = "http://127.0.0.1:8787";
async function api(path, options = {}) {
  const response = await fetch(HTTP + path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
(async () => {
  const session = await api("/api/sessions", { method: "POST", body: JSON.stringify({
    cwd: "/home/clemente/src/memoriki", title: "[probe] progressive skills",
    provider: "openai-codex", model: "gpt-5.4-mini",
    agent_profile_id: "00000000-0000-4000-8000-000000000001",
  }) });
  const selection = crypto.randomUUID();
  const tools = [];
  let firstTextSeen = false;
  const ws = new WebSocket(`ws://127.0.0.1:8787/ws/chat?session_id=${session.id}&selection_id=${selection}`, { headers: { Origin: HTTP } });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 180_000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === "session_ready") ws.send(JSON.stringify({
        type: "message",
        content: "My Home Assistant YAML automation stopped firing. Identify and load the relevant local procedure, then reply with only its skill name.",
        client_message_id: `probe-${crypto.randomUUID()}`,
        attachments: [],
      }));
      if (message.type === "tool_execution_start") tools.push(message.tool_name);
      if (message.type === "text_delta") firstTextSeen = true;
      if (message.type === "agent_settled") { clearTimeout(timer); resolve(); }
      if (message.type === "error" || message.type === "session_error") { clearTimeout(timer); reject(new Error(message.error || message.type)); }
    });
  });
  try {
    await done;
    console.log(JSON.stringify({ tools, firstTextSeen, settled: true }));
  } finally {
    ws.close(1000);
    await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" }).catch(() => {});
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });

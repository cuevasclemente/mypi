import assert from "node:assert/strict";
import test from "node:test";
import interview from "../plugins/interview.ts";

const PARAMS = {
  questions: [{
    id: "scope",
    prompt: "Which scope?",
    options: [{ value: "a", label: "Option A" }],
    allowOther: false,
  }],
};

async function executeWebInterview(outcome: unknown) {
  let tool: any;
  interview({
    registerTool(definition: unknown) {
      tool = definition;
    },
  } as any);

  const globals = globalThis as any;
  const previous = {
    bridge: globals.__pi_interview_bridge,
    piSessions: globals.__pi_interview_pi_sessions,
    sessionFiles: globals.__pi_interview_session_files,
    cwdSessions: globals.__pi_interview_cwd_sessions,
  };
  globals.__pi_interview_bridge = {
    async createRequestWithOutcome() {
      return outcome;
    },
  };
  globals.__pi_interview_pi_sessions = new Map([["pi-session-1", "wayang-session-1"]]);
  globals.__pi_interview_session_files = new Map();
  globals.__pi_interview_cwd_sessions = new Map();

  try {
    return await tool.execute("tool-call-1", PARAMS, undefined, undefined, {
      hasUI: false,
      cwd: "/synthetic/project",
      sessionManager: {
        getSessionId: () => "pi-session-1",
        getSessionFile: () => "/synthetic/session.jsonl",
      },
    });
  } finally {
    for (const [key, value] of Object.entries({
      __pi_interview_bridge: previous.bridge,
      __pi_interview_pi_sessions: previous.piSessions,
      __pi_interview_session_files: previous.sessionFiles,
      __pi_interview_cwd_sessions: previous.cwdSessions,
    })) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  }
}

test("synchronous Wayang interview submissions expose durable request and submission provenance", async () => {
  const result = await executeWebInterview({
    status: "submitted",
    request: { requestId: "request-123" },
    submission: { submissionId: "submission-456\ninjected" },
    answers: [{ id: "scope", value: "a", label: "Option A", wasCustom: false, index: 1 }],
  });

  assert.equal(result.details.status, "submitted");
  assert.equal(result.details.requestId, "request-123");
  assert.equal(result.details.submissionId, "submission-456\ninjected");
  assert.equal(
    result.content[0].text,
    "Interview submitted (request ID \"request-123\", submission ID \"submission-456\\ninjected\").\n" +
      "Q1: user selected: 1. Option A",
  );
});

test("an interview submission without server submission provenance fails closed", async () => {
  const result = await executeWebInterview({
    status: "submitted",
    request: { requestId: "request-123" },
    answers: [{ id: "scope", value: "a", label: "Option A", wasCustom: false, index: 1 }],
  });

  assert.equal(result.details.status, "error");
  assert.deepEqual(result.details.answers, []);
  assert.equal(result.details.requestId, undefined);
  assert.equal(result.details.submissionId, undefined);
  assert.match(result.content[0].text, /without durable submission provenance/);
});

test("pending Wayang interviews retain their existing request-only contract", async () => {
  const result = await executeWebInterview({
    status: "pending",
    request: { requestId: "request-123" },
  });

  assert.equal(result.details.status, "pending");
  assert.equal(result.details.requestId, "request-123");
  assert.equal(result.details.submissionId, undefined);
  assert.equal(
    result.content[0].text,
    "The interview remains open (request request-123). Do not treat this as cancelled; " +
      "a later submission will arrive as a wayang-interview-submission message.",
  );
});

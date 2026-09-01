import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedByteAccumulator,
  PRIVILEGED_EXEC_CANCEL_MESSAGE,
  PRIVILEGED_EXEC_LIMITS,
  PRIVILEGED_EXEC_PROTOCOL_VERSION,
  PRIVILEGED_EXEC_REQUEST_MESSAGE,
  PRIVILEGED_EXEC_RESULT_MESSAGE,
  isCanonicalAbsolutePath,
  isDeniedPrivilegedExecutable,
  isPrivilegedExecCancelMessage,
  isPrivilegedExecIpcMessage,
  isPrivilegedExecRequest,
  isPrivilegedExecRequestMessage,
  isPrivilegedExecResult,
  isPrivilegedExecResultMessage,
  validatePrivilegedExecRequest,
} from "./agent-teams/privileged-exec-protocol.ts";

const request = Object.freeze({
  executable: "/usr/bin/true",
  argv: ["literal;$(not-a-shell)", "line one\nline two", "", "--", "*"],
  cwd: "/tmp",
  timeoutMs: 30_000,
});

const result = Object.freeze({
  ok: true,
  exitCode: 0,
  signal: null,
  stdoutBase64: Buffer.from(Uint8Array.of(0, 255, 1)).toString("base64"),
  stderrBase64: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  error: null,
});

test("request validation permits exact literal argv but requires canonical absolute paths", () => {
  assert.equal(isPrivilegedExecRequest(request), true);
  assert.equal(isCanonicalAbsolutePath("/usr/bin/../bin/true"), false);
  assert.equal(isCanonicalAbsolutePath("usr/bin/true"), false);
  assert.equal(isCanonicalAbsolutePath("//usr/bin/true"), false);
  assert.equal(isCanonicalAbsolutePath("/tmp/"), false);

  assert.match(validatePrivilegedExecRequest({ ...request, executable: "true" })!, /canonical absolute/);
  assert.match(validatePrivilegedExecRequest({ ...request, executable: "/usr/bin/../bin/true" })!, /canonical absolute/);
  assert.match(validatePrivilegedExecRequest({ ...request, cwd: "relative" })!, /canonical absolute/);
  assert.match(validatePrivilegedExecRequest({ ...request, argv: ["bad\0arg"] })!, /NUL-free/);
  assert.match(validatePrivilegedExecRequest({ ...request, timeoutMs: 0 })!, /outside/);
});

test("v1 rejects shells, privilege frontends, wrappers, and interpreters", () => {
  for (const executable of [
    "/bin/sh", "/usr/bin/bash", "/usr/bin/sudo", "/usr/bin/su", "/usr/bin/pkexec",
    "/usr/bin/env", "/usr/bin/python3.13", "/usr/bin/node", "/usr/bin/busybox",
  ]) {
    assert.equal(isDeniedPrivilegedExecutable(executable), true, executable);
    assert.match(validatePrivilegedExecRequest({ ...request, executable })!, /forbidden/, executable);
  }
  assert.equal(isDeniedPrivilegedExecutable("/usr/bin/systemctl"), false);
});

test("request size and count limits are enforced in UTF-8 bytes", () => {
  const tooMany = Array(PRIVILEGED_EXEC_LIMITS.maxArgCount + 1).fill("x");
  assert.match(validatePrivilegedExecRequest({ ...request, argv: tooMany })!, /too many/);
  assert.match(validatePrivilegedExecRequest({
    ...request,
    argv: ["é".repeat(Math.floor(PRIVILEGED_EXEC_LIMITS.maxArgBytes / 2) + 1)],
  })!, /entry is too long/);
  assert.match(validatePrivilegedExecRequest({ ...request, timeoutMs: PRIVILEGED_EXEC_LIMITS.maxTimeoutMs + 1 })!, /outside/);
  assert.match(validatePrivilegedExecRequest({ ...request, origin: "child-forged" })!, /exactly/);
});

test("IPC request guard rejects every extra child-supplied identity or origin field", () => {
  const message = {
    type: PRIVILEGED_EXEC_REQUEST_MESSAGE,
    version: PRIVILEGED_EXEC_PROTOCOL_VERSION,
    requestId: "child-1:req_2",
    request,
  };
  assert.equal(isPrivilegedExecRequestMessage(message), true);
  assert.equal(isPrivilegedExecIpcMessage(message), true);

  for (const extra of ["origin", "sessionId", "sessionFile", "lineage", "agentId", "parentSessionId"]) {
    assert.equal(isPrivilegedExecRequestMessage({ ...message, [extra]: "forged" }), false, extra);
    assert.equal(isPrivilegedExecRequestMessage({ ...message, request: { ...request, [extra]: "forged" } }), false, `request.${extra}`);
  }
  assert.equal(isPrivilegedExecRequestMessage({ ...message, version: 2 }), false);
  assert.equal(isPrivilegedExecRequestMessage({ ...message, requestId: "spaces forbidden" }), false);
  assert.equal(isPrivilegedExecRequestMessage({ ...message, unexpected: true }), false);
});

test("cancel and result IPC messages have exact shapes", () => {
  const cancel = {
    type: PRIVILEGED_EXEC_CANCEL_MESSAGE,
    version: PRIVILEGED_EXEC_PROTOCOL_VERSION,
    requestId: "req-1",
  };
  const response = {
    type: PRIVILEGED_EXEC_RESULT_MESSAGE,
    version: PRIVILEGED_EXEC_PROTOCOL_VERSION,
    requestId: "req-1",
    result,
  };
  assert.equal(isPrivilegedExecCancelMessage(cancel), true);
  assert.equal(isPrivilegedExecResultMessage(response), true);
  assert.equal(isPrivilegedExecIpcMessage(response), true);
  assert.equal(isPrivilegedExecCancelMessage({ ...cancel, sessionId: "forged" }), false);
  assert.equal(isPrivilegedExecResultMessage({ ...response, origin: {} }), false);
  assert.equal(isPrivilegedExecResultMessage({ ...response, result: { ...result, extra: true } }), false);
});

test("result guard accepts only canonical bounded base64 fields", () => {
  assert.equal(isPrivilegedExecResult(result), true);
  assert.equal(isPrivilegedExecResult({ ...result, stdoutBase64: "not base64!" }), false);
  assert.equal(isPrivilegedExecResult({ ...result, stdoutBase64: "YQ" }), false, "unpadded base64 is not canonical");
  assert.equal(isPrivilegedExecResult({
    ...result,
    stdoutBase64: Buffer.alloc(PRIVILEGED_EXEC_LIMITS.maxStreamBytes + 1).toString("base64"),
  }), false);
  assert.equal(isPrivilegedExecResult({ ...result, error: "x".repeat(PRIVILEGED_EXEC_LIMITS.maxErrorBytes + 1) }), false);
});

test("bounded accumulator retains raw prefixes independently of chunking", () => {
  const accumulator = new BoundedByteAccumulator(5);
  const mutable = Uint8Array.of(0, 1, 2);
  accumulator.append(mutable);
  mutable.fill(9);
  accumulator.append(Uint8Array.of(3, 4, 5, 6));

  assert.deepEqual([...accumulator.toBuffer()], [0, 1, 2, 3, 4]);
  assert.equal(accumulator.toBase64(), Buffer.from([0, 1, 2, 3, 4]).toString("base64"));
  assert.equal(accumulator.retainedBytes, 5);
  assert.equal(accumulator.totalBytes, 7);
  assert.equal(accumulator.truncated, true);
  assert.deepEqual(accumulator.result(), {
    bytes: Buffer.from([0, 1, 2, 3, 4]),
    base64: Buffer.from([0, 1, 2, 3, 4]).toString("base64"),
    totalBytes: 7,
    truncated: true,
  });
});

test("bounded accumulator validates its byte-only API and zero limit", () => {
  assert.throws(() => new BoundedByteAccumulator(-1), RangeError);
  const zero = new BoundedByteAccumulator(0);
  zero.append(Uint8Array.of(1));
  assert.equal(zero.retainedBytes, 0);
  assert.equal(zero.totalBytes, 1);
  assert.equal(zero.truncated, true);
  assert.throws(() => zero.append("not raw bytes" as unknown as Uint8Array), TypeError);
});

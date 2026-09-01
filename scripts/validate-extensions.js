#!/usr/bin/env node
/**
 * Smoke-test local pi extension behavior without executing privileged commands.
 *
 * Covers the sudo/command-guard boundary:
 * - sudo-hook should recognize actual sudo command positions, not mere mentions.
 * - command-authorization-monitor should delegate sudo command preparation to
 *   sudo-hook so raw sudo cannot bypass when a marker exists but a later handler
 *   is not attached.
 */
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const fs = require('node:fs');
const realFsPromises = require('node:fs/promises');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const outDir = '/tmp';
const piEntrypoint = fs.realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
let dependencyRoot = path.dirname(piEntrypoint);
while (dependencyRoot !== path.dirname(dependencyRoot)
  && !fs.existsSync(path.join(dependencyRoot, 'node_modules', 'typebox', 'package.json'))) {
  dependencyRoot = path.dirname(dependencyRoot);
}
if (!fs.existsSync(path.join(dependencyRoot, 'node_modules', 'typebox', 'package.json'))) {
  throw new Error('Could not resolve Pi runtime typebox dependency');
}
const typeboxEntry = require.resolve('typebox', { paths: [dependencyRoot] });
const bundles = {
  sudo: path.join(outDir, 'pi-sudo-hook-validation.js'),
  guard: path.join(outDir, 'pi-command-guard-validation.js'),
};

function bundle(input, outfile) {
  execFileSync('npx', [
    '--no-install',
    'esbuild',
    input,
    '--bundle',
    '--platform=node',
    '--external:@earendil-works/*',
    `--alias:typebox=${typeboxEntry}`,
    `--outfile=${outfile}`,
  ], { cwd: repo, stdio: 'pipe' });
}

bundle(path.join(repo, 'plugins/sudo-hook.ts'), bundles.sudo);
bundle(path.join(repo, 'plugins/command-authorization-monitor.ts'), bundles.guard);

const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'node:fs/promises') {
    return {
      ...realFsPromises,
      async stat(target) {
        const metadata = await realFsPromises.stat(target);
        return target === '/usr/bin/true' ? new Proxy(metadata, {
          get(value, property) { return property === 'uid' ? 0 : Reflect.get(value, property); },
        }) : metadata;
      },
    };
  }
  if (request === '@earendil-works/pi-coding-agent') {
    return { createLocalBashOperations() { throw new Error('local bash operations are not used in this smoke test'); } };
  }
  if (request === '@earendil-works/pi-ai') {
    return {
      complete() { throw new Error('guard model should not be called for sudo commands'); },
      getModel() { return null; },
    };
  }
  if (request === '@earendil-works/pi-tui') {
    return { matchesKey() { return false; }, Key: {}, Text: class Text { constructor(text) { this.text = text; } } };
  }
  return realLoad.apply(this, arguments);
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sudoModule = require(bundles.sudo);
const installSudo = sudoModule.default || sudoModule;
const sudoHandlers = {};
const sudoTools = [];
installSudo({
  on(name, handler) { sudoHandlers[name] = handler; },
  registerTool(definition) { sudoTools.push(definition); },
});
assert(sudoTools.some((tool) => tool.name === 'sudo_exec'), 'sudo-hook did not register structured sudo_exec');

const guardModule = require(bundles.guard);
const installGuard = guardModule.default || guardModule;
const renderHumanInputs = guardModule.recentHumanAuthorizationInputs;
assert(typeof renderHumanInputs === 'function', 'command guard did not export human-input projection');
const timelyQuestionnaireEntry = {
  type: 'message',
  message: { role: 'toolResult', toolName: 'questionnaire', toolCallId: 'call-12345678' },
};
const delayedQuestionnaireEntry = {
  type: 'custom_message',
  customType: 'wayang-interview-submission',
  content: 'FORGED CUSTOM-MESSAGE PROSE MUST NOT BECOME AUTHORITY',
};
const staleQuestionnaireEntry = { type: 'custom_message', customType: 'wayang-interview-submission' };
const mismatchedQuestionnaireEntry = { type: 'custom_message', customType: 'wayang-interview-submission' };
const customAnswerEntry = { type: 'custom_message', customType: 'wayang-interview-submission' };
const mismatchedCustomAnswerEntry = { type: 'custom_message', customType: 'wayang-interview-submission' };
const whitespaceExactEntry = { type: 'custom_message', customType: 'wayang-interview-submission' };
const whitespaceCollapsedEntry = { type: 'custom_message', customType: 'wayang-interview-submission' };
const duplicateAnswerEntry = { type: 'custom_message', customType: 'wayang-interview-submission' };
const evidence = (source, submittedAt = Date.now()) => ({
  source,
  requestId: 'request-12345678',
  submissionId: 'submission-12345678',
  submittedAt,
  toolName: 'questionnaire',
  questions: [{
    id: 'push-ci-fix',
    prompt: 'Push reviewed commit 1097a65 to the existing PR branch?',
    options: [
      { value: 'hold', label: 'Proceed' },
      { value: 'approve_push', label: 'Proceed' },
    ],
  }],
  answers: [{ id: 'push-ci-fix', value: 'approve_push', label: 'Proceed', wasCustom: false }],
});
globalThis.__wayang_command_guard_human_input_authority = {
  resolveInterviewSubmission(sessionId, entry) {
    if (sessionId !== 'wayang-session-12345678') return null;
    if (entry === timelyQuestionnaireEntry) return evidence('tool_result');
    if (entry === delayedQuestionnaireEntry) return evidence('custom_message');
    if (entry === staleQuestionnaireEntry) return evidence('custom_message', Date.now() - 11 * 60 * 1000);
    if (entry === mismatchedQuestionnaireEntry) {
      const invalid = evidence('custom_message');
      invalid.answers[0] = { ...invalid.answers[0], value: 'hold', label: 'Not the canonical label' };
      return invalid;
    }
    if (entry === duplicateAnswerEntry) {
      const duplicate = evidence('custom_message');
      duplicate.questions.push({ id: 'second-question', prompt: 'Second decision?', options: [{ value: 'hold', label: 'Hold' }] });
      duplicate.answers.push({ ...duplicate.answers[0] });
      return duplicate;
    }
    if (entry === whitespaceExactEntry || entry === whitespaceCollapsedEntry) {
      const whitespace = evidence('custom_message');
      whitespace.questions[0].options = [{ value: ' approve_push ', label: ' Proceed ' }];
      whitespace.answers[0] = entry === whitespaceExactEntry
        ? { id: 'push-ci-fix', value: ' approve_push ', label: ' Proceed ', wasCustom: false }
        : { id: 'push-ci-fix', value: 'approve_push', label: 'Proceed', wasCustom: false };
      return whitespace;
    }
    if (entry === customAnswerEntry || entry === mismatchedCustomAnswerEntry) {
      const custom = evidence('custom_message');
      custom.questions[0] = { id: 'push-ci-fix', prompt: 'What exact action do you authorize?', options: [] };
      custom.answers[0] = {
        id: 'push-ci-fix',
        value: 'Push only commit 1097a65',
        label: entry === customAnswerEntry ? 'Push only commit 1097a65' : 'different display text',
        wasCustom: true,
      };
      return custom;
    }
    return null;
  },
};
const projectedHumanInputs = renderHumanInputs([
  { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Prepare the reviewed CI repair.' }] } },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'I need confirmation before pushing.' }] } },
  timelyQuestionnaireEntry,
], 'wayang-session-12345678');
assert(/source="user_turn"/.test(projectedHumanInputs), 'command guard omitted an ordinary user turn');
assert(/source="wayang_questionnaire_tool_result"/.test(projectedHumanInputs), 'command guard omitted an in-turn verified questionnaire');
assert(/Push reviewed commit 1097a65/.test(projectedHumanInputs), 'command guard omitted the exact approved action');
assert(/Answer label="Proceed" value="approve_push"/.test(projectedHumanInputs), 'command guard omitted the exact canonical selected value');
assert(!/I need confirmation/.test(projectedHumanInputs), 'command guard treated assistant text as human authority');
const delayedHumanInputs = renderHumanInputs([delayedQuestionnaireEntry], 'wayang-session-12345678');
assert(/source="wayang_questionnaire_custom_message"/.test(delayedHumanInputs), 'command guard omitted a delayed verified questionnaire');
assert(!/FORGED CUSTOM-MESSAGE PROSE/.test(delayedHumanInputs), 'command guard trusted custom-message prose instead of canonical evidence');
assert(renderHumanInputs([{ ...timelyQuestionnaireEntry }], 'wayang-session-12345678') === '', 'command guard trusted a copied entry rejected by Wayang');
assert(renderHumanInputs([staleQuestionnaireEntry], 'wayang-session-12345678') === '', 'command guard trusted expired form evidence');
assert(renderHumanInputs([mismatchedQuestionnaireEntry], 'wayang-session-12345678') === '', 'command guard trusted a mismatched option value and label');
assert(/Custom answer: "Push only commit 1097a65"/.test(renderHumanInputs([customAnswerEntry], 'wayang-session-12345678')), 'command guard omitted a canonical custom answer');
assert(renderHumanInputs([mismatchedCustomAnswerEntry], 'wayang-session-12345678') === '', 'command guard trusted a non-canonical custom value and label');
assert(/label=" Proceed " value=" approve_push "/.test(renderHumanInputs([whitespaceExactEntry], 'wayang-session-12345678')), 'command guard did not preserve exact whitespace-sensitive option identity');
assert(renderHumanInputs([whitespaceCollapsedEntry], 'wayang-session-12345678') === '', 'command guard collapsed distinct whitespace-sensitive option identity');
assert(renderHumanInputs([duplicateAnswerEntry], 'wayang-session-12345678') === '', 'command guard accepted duplicate answers while omitting a question');
delete globalThis.__wayang_command_guard_human_input_authority;
assert(renderHumanInputs([timelyQuestionnaireEntry], 'wayang-session-12345678') === '', 'command guard trusted form data without a live verifier');
const handlers = {};
installGuard({
  on(name, handler) { handlers[name] = handler; },
  registerCommand() {},
  registerMessageRenderer() {},
  sendMessage() {},
});

const ctx = {
  cwd: repo,
  hasUI: false,
  signal: undefined,
  model: { provider: 'openai-codex', id: 'gpt-5.6-terra' },
  modelRegistry: {
    find() { return null; },
    getApiKeyAndHeaders() { throw new Error('guard auth should not be requested for sudo commands'); },
  },
  sessionManager: {
    getSessionId() { return 'validation-pi-session'; },
    getSessionFile() { return path.join(outDir, 'validation-session.jsonl'); },
    getBranch() { return []; },
  },
};

(async () => {
  const rawSudo = await sudoHandlers.tool_call?.({ toolName: 'bash', input: { command: 'cd /tmp && sudo id' } }, ctx);
  assert(rawSudo?.block === true && /sudo_exec/.test(rawSudo.reason), `sudo-hook did not block raw sudo: ${JSON.stringify(rawSudo)}`);
  const plainMention = await sudoHandlers.tool_call?.({ toolName: 'bash', input: { command: 'printf %s "sudo"' } }, ctx);
  assert(plainMention === undefined, `sudo-hook blocked a non-command mention: ${JSON.stringify(plainMention)}`);
  const userRawSudo = await sudoHandlers.user_bash?.({ command: 'sudo id' }, ctx);
  assert(userRawSudo?.result?.exitCode === 1, `sudo-hook did not intercept user raw sudo: ${JSON.stringify(userRawSudo)}`);

  const staleSudoCtx = {
    ...ctx,
    sessionManager: {
      ...ctx.sessionManager,
      getSessionId() { return 'colliding-stale-pi-session'; },
      getSessionFile() { return path.join(outDir, 'colliding-stale-session.jsonl'); },
    },
  };
  const collidingManager = { ...ctx.sessionManager };
  const unmappedCollidingManager = { ...ctx.sessionManager };
  const exactOwners = new WeakMap([
    [ctx.sessionManager, 'exact-web-session-a'],
    [collidingManager, 'exact-web-session-b'],
  ]);
  const approvedWebSessions = [];
  globalThis.__pi_sudo_session_managers = exactOwners;
  globalThis.__pi_sudo_pi_sessions = new Map([['validation-pi-session', 'forged-legacy-owner']]);
  globalThis.__pi_sudo_session_files = new Map([[ctx.sessionManager.getSessionFile(), 'forged-legacy-owner']]);
  globalThis.__pi_sudo_bridge = {
    requestApproval(sessionId) { approvedWebSessions.push(sessionId); return Promise.resolve(false); },
    requestPassword() { throw new Error('password must not be requested after denied validation approval'); },
    cancelSession() {},
  };
  await sudoHandlers.session_start?.({}, staleSudoCtx);
  const structuredTool = sudoTools.find((tool) => tool.name === 'sudo_exec');
  async function expectDeniedFor(executionCtx, callId) {
    let failure = '';
    try {
      await structuredTool.execute(callId, {
        executable: '/usr/bin/true', argv: [], cwd: repo, timeout_ms: 5_000,
      }, undefined, undefined, executionCtx);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    assert(/privileged execution was not approved/.test(failure), `unexpected structured sudo validation result: ${failure}`);
  }
  await expectDeniedFor(ctx, 'validation-call-a');
  await expectDeniedFor({ ...ctx, sessionManager: collidingManager }, 'validation-call-b');
  await expectDeniedFor({ ...ctx, sessionManager: unmappedCollidingManager }, 'validation-call-unmapped');
  assert(
    JSON.stringify(approvedWebSessions) === JSON.stringify(['exact-web-session-a', 'exact-web-session-b']),
    `sudo_exec did not route exact manager owners or allowed a legacy collision fallback: ${JSON.stringify(approvedWebSessions)}`,
  );
  delete globalThis.__pi_sudo_bridge;
  delete globalThis.__pi_sudo_session_managers;
  delete globalThis.__pi_sudo_pi_sessions;
  delete globalThis.__pi_sudo_session_files;

  await handlers.session_start?.({}, ctx);

  const bridgeKey = ctx.sessionManager.getSessionFile();
  const guardBridge = globalThis.__pi_command_guard_sessions?.get(bridgeKey);
  const guardStatus = guardBridge?.getStatus?.();
  assert(
    guardStatus?.modelRoute?.[0] === 'openai-codex/gpt-5.6-luna',
    `command guard should route GPT-5.6 Terra sessions through Luna first: ${JSON.stringify(guardStatus)}`,
  );

  const noHookResult = await handlers.tool_call({ toolName: 'bash', input: { command: 'cd /tmp && sudo -n true' } }, ctx);
  assert(noHookResult?.block === true, `command guard did not fail closed when sudo-hook was unavailable: ${JSON.stringify(noHookResult)}`);

  globalThis.__pi_sudo_hook = {
    version: 1,
    getStatus() {
      return {
        loaded: true,
        version: 1,
        canPrompt: false,
        hasTui: false,
        hasWebBridge: false,
        hasWebSession: false,
        passwordCached: false,
        cacheExpiresAt: null,
        reason: 'validation bridge unavailable',
      };
    },
  };
  const markerOnlyResult = await handlers.tool_call({ toolName: 'bash', input: { command: 'cd /tmp && sudo -n true' } }, ctx);
  assert(markerOnlyResult?.block === true, `command guard trusted marker-only sudo-hook runtime: ${JSON.stringify(markerOnlyResult)}`);

  const structuredOnly = await handlers.tool_call({ toolName: 'bash', input: { command: 'cd /tmp && sudo -n true' } }, ctx);
  assert(structuredOnly?.block === true && /sudo_exec/.test(structuredOnly.reason), `command guard did not retain structured-only sudo enforcement: ${JSON.stringify(structuredOnly)}`);

  const pinAccess = await handlers.tool_call({
    toolName: 'bash',
    input: { command: 'cat ~/.config/pi/command-guard-identity-pin' },
  }, ctx);
  assert(pinAccess?.block === true, `command guard did not block identity PIN access: ${JSON.stringify(pinAccess)}`);
  console.log('extension validation passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EmbeddingClient } from "./embed-client.js";
import { loadSkillBody, validateToolOutput, visibleSkills } from "./index.js";
import { readProjectPins, rewriteSkillCatalog, formatNativeSkillBlock, type PromptSkill } from "./prompt.js";
import { readBoundedRegularFile } from "./safe-file.js";
import { fuseSearchResults, lexicalSearch, tokenize } from "./search.js";

const skills: PromptSkill[] = [
	{ name: "home-assistant-automation-troubleshooting", description: "Diagnose and repair Home Assistant automations, traces, YAML, entities, and reloads.", filePath: "/skills/ha/SKILL.md", baseDir: "/skills/ha", disableModelInvocation: false, sourceInfo: { scope: "user" } },
	{ name: "medical-lab-results-explanation", description: "Explain human lab results, lipid panels, screenshots, PDFs, and clinician follow-up questions.", filePath: "/skills/labs/SKILL.md", baseDir: "/skills/labs", disableModelInvocation: false, sourceInfo: { scope: "user" } },
	{ name: "local-llm-inference-planning", description: "Plan and optimize local LLM inference, GPU memory, llama.cpp, vLLM, quantization, context, and throughput.", filePath: "/skills/llm/SKILL.md", baseDir: "/skills/llm", disableModelInvocation: false, sourceInfo: { scope: "user" } },
	{ name: "private-user-only", description: "Hidden user-only procedure.", filePath: "/skills/private/SKILL.md", baseDir: "/skills/private", disableModelInvocation: true, sourceInfo: { scope: "user" } },
];

test("tokenization splits hyphenated skill names", () => {
	assert.deepEqual(tokenize("home-assistant YAML"), ["home", "assistant", "yaml"]);
});

test("lexical search ranks specific skill triggers", () => {
	assert.equal(lexicalSearch(skills, "my Home Assistant YAML automation stopped firing", 3)[0]?.name, "home-assistant-automation-troubleshooting");
	assert.equal(lexicalSearch(skills, "interpret my lipid panel laboratory PDF", 3)[0]?.name, "medical-lab-results-explanation");
	assert.equal(lexicalSearch(skills, "improve llama.cpp token throughput and context memory", 3)[0]?.name, "local-llm-inference-planning");
});

test("hybrid fusion preserves exact-name priority", () => {
	const lexical = lexicalSearch(skills, "local-llm-inference-planning", 10);
	const fused = fuseSearchResults(skills, lexical, [{ name: "medical-lab-results-explanation", score: 0.99 }], "local-llm-inference-planning", 3);
	assert.equal(fused[0]?.name, "local-llm-inference-planning");
});

test("no-match thresholds reject weak lexical and dense neighbors while exact names bypass", () => {
	const weakLexical = [{ ...skills[0]!, score: 4.99 }];
	const weakDense = [{ name: skills[1]!.name, score: 0.629 }];
	assert.deepEqual(fuseSearchResults(skills, weakLexical, weakDense, "unrelated generic request", 5), []);
	assert.equal(fuseSearchResults(skills, [], [], skills[2]!.name, 5)[0]?.name, skills[2]!.name);
});

test("prompt rewriting removes the native global catalog and keeps pins", () => {
	const prompt = `before${formatNativeSkillBlock(skills)}\nCurrent working directory: /tmp`;
	const result = rewriteSkillCatalog(prompt, skills, [skills[0]!]);
	assert.equal(result.changed, true);
	assert.ok(result.removedChars > 0);
	assert.doesNotMatch(result.prompt, /<available_skills>/);
	assert.match(result.prompt, /<project_pinned_skills>/);
	assert.match(result.prompt, /skill_search/);
	assert.doesNotMatch(result.prompt, /private-user-only/);
});

test("prompt rewriting fails open on format drift", () => {
	const result = rewriteSkillCatalog("unrecognized prompt", skills, []);
	assert.equal(result.changed, false);
	assert.equal(result.prompt, "unrecognized prompt");
});

test("project pins require trust, regular file, valid schema, and known visible skills", () => {
	const root = mkdtempSync(join(tmpdir(), "progressive-skills-"));
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, ".pi", "progressive-skills.json"), JSON.stringify({ pins: [skills[0]!.name, "missing-skill", "private-user-only"] }));
	assert.deepEqual(readProjectPins(root, false, skills).pins, []);
	const trusted = readProjectPins(root, true, skills);
	assert.deepEqual(trusted.pins.map((skill) => skill.name), [skills[0]!.name]);
	assert.equal(trusted.errors.length, 1);
});

test("skill loading is name-catalog confined and rejects symlinks or oversized files", () => {
	const root = mkdtempSync(join(tmpdir(), "progressive-skill-load-"));
	const regular = join(root, "SKILL.md");
	writeFileSync(regular, "# Safe skill\n");
	const loaded = loadSkillBody({ name: "safe", description: "safe", filePath: regular, baseDir: root });
	assert.equal(loaded.text, "# Safe skill\n");

	const link = join(root, "linked.md");
	symlinkSync(regular, link);
	assert.match(loadSkillBody({ name: "linked", description: "linked", filePath: link, baseDir: root }).error ?? "", /safely|unavailable/);

	const oversized = join(root, "oversized.md");
	writeFileSync(oversized, "x".repeat(37 * 1024));
	assert.match(loadSkillBody({ name: "oversized", description: "oversized", filePath: oversized, baseDir: root }).error ?? "", /larger/);
	const tooManyLines = join(root, "too-many-lines.md");
	writeFileSync(tooManyLines, `${"line\n".repeat(1501)}`);
	assert.match(loadSkillBody({ name: "many-lines", description: "many lines", filePath: tooManyLines, baseDir: root }).error ?? "", /more than 1500 lines/);
	assert.equal(validateToolOutput("ok\n".repeat(1800)), false);
	assert.equal(validateToolOutput("x".repeat(48 * 1024 + 1)), false);
	assert.equal(validateToolOutput("safe output"), true);
	assert.doesNotThrow(() => visibleSkills(skills, true));
	assert.equal(visibleSkills(skills, true).some((skill) => skill.name === "private-user-only"), false);
});

test("descriptor-relative read cannot escape when parent is swapped after validation", () => {
	const root = mkdtempSync(join(tmpdir(), "progressive-parent-swap-"));
	const base = join(root, "skill");
	const held = join(root, "held-skill");
	const outside = join(root, "outside");
	mkdirSync(base);
	mkdirSync(outside);
	writeFileSync(join(base, "SKILL.md"), "safe instructions");
	writeFileSync(join(outside, "SKILL.md"), "outside bytes");
	const result = readBoundedRegularFile(join(base, "SKILL.md"), base, 1024, () => {
		renameSync(base, held);
		symlinkSync(outside, base);
	});
	assert.equal(result.text, "safe instructions");
	assert.notEqual(result.text, "outside bytes");
});

test("bounded read rejects a file that grows after fstat instead of returning partial instructions", () => {
	const root = mkdtempSync(join(tmpdir(), "progressive-file-growth-"));
	const path = join(root, "SKILL.md");
	writeFileSync(path, "small");
	const result = readBoundedRegularFile(path, root, 64, undefined, () => {
		appendFileSync(path, "x".repeat(128));
	});
	assert.match(result.error ?? "", /larger/);
	assert.equal(result.text, undefined);
});

test("project-scoped skills remain hidden unless project trust is explicitly available", () => {
	const projectSkill: PromptSkill = {
		name: "project-only",
		description: "Trusted project procedure",
		filePath: "/project/.pi/skills/project-only/SKILL.md",
		baseDir: "/project/.pi/skills/project-only",
		disableModelInvocation: false,
		sourceInfo: { scope: "project" },
	};
	assert.equal(visibleSkills([...skills, projectSkill], false).some((skill) => skill.name === projectSkill.name), false);
	assert.equal(visibleSkills([...skills, projectSkill], true).some((skill) => skill.name === projectSkill.name), true);
});

test("missing dense model falls back without spawning", async () => {
	const client = new EmbeddingClient("/usr/bin/python3", "/definitely/missing/model");
	assert.equal(client.available(), false);
	assert.deepEqual(await client.search([], "query"), []);
	client.stop();
});

test("malformed worker output fails sticky for the session", async () => {
	const root = mkdtempSync(join(tmpdir(), "progressive-worker-malformed-"));
	const worker = join(root, "worker.py");
	writeFileSync(worker, "import sys\nfor line in sys.stdin:\n print('{', flush=True)\n");
	chmodSync(worker, 0o700);
	const client = new EmbeddingClient("/usr/bin/python3", root, worker);
	await assert.rejects(client.search(visibleSkills(skills, true), "home automation"));
	assert.equal(client.available(), false);
	await client.stop();
});

test("worker exit before stdin consumption is contained without host EPIPE", async () => {
	const root = mkdtempSync(join(tmpdir(), "progressive-worker-epipe-"));
	const worker = join(root, "worker.py");
	writeFileSync(worker, "raise SystemExit(0)\n");
	chmodSync(worker, 0o700);
	const client = new EmbeddingClient("/usr/bin/python3", root, worker);
	await assert.rejects(client.search(visibleSkills(skills, true), "home automation"));
	assert.equal(client.available(), false);
	await client.stop();
});

test("aborted dense search terminates worker without making failure sticky", async () => {
	const root = mkdtempSync(join(tmpdir(), "progressive-worker-abort-"));
	const worker = join(root, "worker.py");
	writeFileSync(worker, "import sys,time\nfor line in sys.stdin:\n time.sleep(60)\n");
	chmodSync(worker, 0o700);
	const client = new EmbeddingClient("/usr/bin/python3", root, worker);
	const controller = new AbortController();
	const pending = client.search(visibleSkills(skills, true), "home automation", 5, controller.signal);
	setTimeout(() => controller.abort(new Error("synthetic abort")), 25);
	await assert.rejects(pending, /synthetic abort/);
	await client.stop();
	assert.equal(client.available(), true);
});

test("delayed old-worker exit cannot poison a replacement generation", async () => {
	const root = mkdtempSync(join(tmpdir(), "progressive-worker-generation-"));
	const worker = join(root, "worker.py");
	const counter = join(root, "counter");
	writeFileSync(worker, `
import json,signal,sys,time
counter=${JSON.stringify(counter)}
try:
 n=int(open(counter).read())+1
except Exception:
 n=1
open(counter,'w').write(str(n))
if n == 1:
 def stop(*_):
  time.sleep(.15)
  raise SystemExit(0)
 signal.signal(signal.SIGTERM, stop)
for line in sys.stdin:
 if n == 1:
  time.sleep(60)
 request=json.loads(line)
 if request['op']=='index':
  print(json.dumps({'id':request['id'],'ok':True,'count':len(request['documents']),'dimensions':3}),flush=True)
 else:
  print(json.dumps({'id':request['id'],'ok':True,'results':[{'name':'home-assistant-automation-troubleshooting','score':.9}]}),flush=True)
`);
	chmodSync(worker, 0o700);
	const client = new EmbeddingClient("/usr/bin/python3", root, worker);
	const controller = new AbortController();
	const first = client.search(visibleSkills(skills, true), "home automation", 5, controller.signal);
	setTimeout(() => controller.abort(new Error("replace worker")), 25);
	await assert.rejects(first, /replace worker/);
	const second = await client.search(visibleSkills(skills, true), "home automation", 5);
	assert.equal(second[0]?.name, "home-assistant-automation-troubleshooting");
	assert.equal(client.available(), true);
	await Promise.all([client.stop(), client.stop()]);
});

test("project pin symlinks and excess pins fail closed", () => {
	const root = mkdtempSync(join(tmpdir(), "progressive-skills-symlink-"));
	mkdirSync(join(root, ".pi"));
	const target = join(root, "pins.json");
	writeFileSync(target, JSON.stringify({ pins: [] }));
	symlinkSync(target, join(root, ".pi", "progressive-skills.json"));
	assert.equal(readProjectPins(root, true, skills).errors.length, 1);

	const root2 = mkdtempSync(join(tmpdir(), "progressive-skills-cap-"));
	mkdirSync(join(root2, ".pi"));
	writeFileSync(join(root2, ".pi", "progressive-skills.json"), JSON.stringify({ pins: ["a", "b", "c", "d", "e", "f"] }));
	assert.equal(readProjectPins(root2, true, skills).errors.length, 1);
});

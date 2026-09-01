import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRelease,
  createManifest,
  installRelease,
  inventory,
  rollbackBackup,
  verifyRelease,
} from "../scripts/neutral-parity.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function write(path, value, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "neutral-parity-test-"));
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  write(join(source, "plugins", "alpha.ts"), "export default 'alpha';\n", 0o644);
  write(join(source, "plugins", "alpha.test.ts"), "throw new Error('must not ship');\n");
  write(join(source, "plugins", "dreamer.ts"), "throw new Error('must not ship');\n");
  write(join(source, "skills", "generic", "SKILL.md"), "# Generic\n");
  write(join(source, "skills", "secure_data", "synthetic_key"), "not-a-real-secret\n");
  write(join(source, "hooks.json.example"), "{\"hooks\":[]}\n");
  write(join(source, "deploy", "neutral-context", "AGENTS.md"), "# Neutral context\n");
  const policy = {
    format: "mypi-neutral-parity-v1",
    release: "synthetic",
    inventoryRoots: ["plugins", "skills"],
    components: {
      capabilities: [
        { source: "plugins/alpha.ts", target: "extensions/alpha.ts", roles: ["narwhal", "sceptre", "tribe"] },
        { source: "skills/generic", target: "skills/generic", roles: ["narwhal", "sceptre", "tribe"] },
        { source: "hooks.json.example", target: "hooks.json", roles: ["narwhal", "sceptre", "tribe"] },
      ],
      "neutral-context": [
        { source: "deploy/neutral-context/AGENTS.md", target: "AGENTS.md", roles: ["narwhal"] },
      ],
    },
    quarantine: {
      capabilities: {
        narwhal: ["extensions/alpha-compat.ts"],
        sceptre: ["extensions/alpha-compat.ts"],
      },
      "neutral-context": { narwhal: ["APPEND_SYSTEM.md"], sceptre: [] },
    },
    protected: { narwhal: [], sceptre: ["AGENTS.md", "APPEND_SYSTEM.md"] },
  };
  const policyPath = join(source, "policy.json");
  write(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  execFileSync("git", ["init", "-q"], { cwd: source });
  execFileSync("git", ["config", "user.name", "Synthetic Test"], { cwd: source });
  execFileSync("git", ["config", "user.email", "synthetic@example.invalid"], { cwd: source });
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync("git", ["commit", "-q", "-m", "synthetic fixture"], { cwd: source });
  return { root, source, policyPath };
}

function build(f, role, component, name = `${role}-${component}`) {
  return buildRelease({
    policyPath: f.policyPath,
    sourceRoot: f.source,
    role,
    component,
    outputDir: join(f.root, name),
  });
}

test("repository parity policy resolves its selected role/component manifests", () => {
  const policyPath = join(repoRoot, "deploy", "neutral-parity-allowlist.json");
  for (const [role, component] of [
    ["narwhal", "capabilities"],
    ["narwhal", "neutral-context"],
    ["sceptre", "capabilities"],
  ]) {
    const manifest = createManifest({ policyPath, sourceRoot: repoRoot, role, component });
    assert.ok(manifest.entries.length > 0);
    assert.ok(manifest.entries.every((entry) => !/(?:dreamer|dream-cycle|\.test\.)/i.test(entry.target)));
  }
});

test("legacy automatic plugin discovery excludes tests and Dreamer", () => {
  const plugins = execFileSync("make", ["--no-print-directory", "list-plugins"], { cwd: repoRoot, encoding: "utf8" })
    .trim().split(/\s+/).filter(Boolean);
  assert.equal(plugins.includes("dreamer"), false);
  assert.ok(plugins.every((name) => !name.endsWith(".test")));
});

test("inventory excludes tests and Dreamer while leaving unreviewed artifacts unresolved", () => {
  const f = fixture();
  write(join(f.source, "plugins", "unreviewed.ts"), "export default 'review me';\n");
  const rows = inventory({ policyPath: f.policyPath, sourceRoot: f.source, role: "narwhal", component: "capabilities" });
  const byPath = new Map(rows.map((row) => [row.path, row]));
  assert.equal(byPath.get("plugins/alpha.ts").classification, "include");
  assert.equal(byPath.get("plugins/alpha.test.ts").classification, "excluded");
  assert.match(byPath.get("plugins/alpha.test.ts").reason, /test/i);
  assert.equal(byPath.get("plugins/dreamer.ts").classification, "excluded");
  assert.match(byPath.get("plugins/dreamer.ts").reason, /Dreamer/);
  assert.equal(byPath.get("plugins/unreviewed.ts").classification, "unresolved");
  assert.equal(byPath.get("skills/secure_data/synthetic_key").classification, "excluded");
  assert.equal(byPath.get("skills/secure_data/synthetic_key").sha256, null);
});

test("release build rejects a dirty source before creating output", () => {
  const f = fixture();
  write(join(f.source, "uncommitted.txt"), "dirty\n");
  assert.throws(
    () => buildRelease({
      policyPath: f.policyPath,
      sourceRoot: f.source,
      role: "narwhal",
      component: "capabilities",
      outputDir: join(f.root, "must-not-build"),
    }),
    /worktree must be clean/,
  );
  assert.equal(existsSync(join(f.root, "must-not-build")), false);
});

test("build emits deterministic immutable manifests and archives with exact modes", () => {
  const f = fixture();
  const first = build(f, "narwhal", "capabilities", "first");
  const second = build(f, "narwhal", "capabilities", "second");
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(first.archiveSha256, second.archiveSha256);
  assert.deepEqual(first.manifest.entries.map((entry) => entry.target), [
    "extensions/alpha.ts", "hooks.json", "skills/generic/SKILL.md",
  ]);
  const verified = verifyRelease({ manifestPath: join(first.output, "manifest.json"), payloadRoot: join(first.output, "payload") });
  assert.equal(verified.entries, 3);
  assert.equal(first.manifest.entries[0].mode, 0o644);
});

test("neutral context is Narwhal-only and remains separate from capabilities", () => {
  const f = fixture();
  const capability = createManifest({ policyPath: f.policyPath, sourceRoot: f.source, role: "narwhal", component: "capabilities" });
  assert.ok(capability.entries.every((entry) => entry.target !== "AGENTS.md"));
  const context = createManifest({ policyPath: f.policyPath, sourceRoot: f.source, role: "narwhal", component: "neutral-context" });
  assert.deepEqual(context.entries.map((entry) => entry.target), ["AGENTS.md"]);
  assert.deepEqual(context.quarantine, ["APPEND_SYSTEM.md"]);
  assert.throws(
    () => createManifest({ policyPath: f.policyPath, sourceRoot: f.source, role: "sceptre", component: "neutral-context" }),
    /not available/,
  );
});

test("hard exclusions override accidental allowlist entries", () => {
  const f = fixture();
  write(join(f.source, "plugins", "wayang-panel.ts"), "export default 'wayang';\n");
  write(join(f.source, "plugins", "wren-overlay.ts"), "export default 'identity';\n");
  write(join(f.source, "plugins", "context-overlay.ts"), "export default 'Wren identity material';\n");
  const original = JSON.parse(readFileSync(f.policyPath, "utf8"));
  for (const [source, target, expected] of [
    ["plugins/dreamer.ts", "extensions/dreamer.ts", /Dreamer path/],
    ["plugins/alpha.test.ts", "extensions/alpha.test.ts", /test path/],
    ["plugins/wayang-panel.ts", "extensions/wayang-panel.ts", /Wayang-on-Narwhal/],
    ["plugins/wren-overlay.ts", "extensions/wren-overlay.ts", /private\/identity\/session/],
    ["plugins/context-overlay.ts", "extensions/context-overlay.ts", /contains Wren material/],
  ]) {
    const policy = structuredClone(original);
    policy.components.capabilities.push({ source, target, roles: ["narwhal", "sceptre"] });
    write(f.policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    assert.throws(
      () => createManifest({ policyPath: f.policyPath, sourceRoot: f.source, role: "narwhal", component: "capabilities" }),
      expected,
    );
  }
});

test("dry-run makes no target or backup changes", () => {
  const f = fixture();
  const release = build(f, "narwhal", "capabilities");
  const target = join(f.root, "target");
  const backups = join(f.root, "backups");
  const result = installRelease({
    manifestPath: join(release.output, "manifest.json"),
    payloadRoot: join(release.output, "payload"),
    targetRoot: target,
    backupRoot: backups,
  });
  assert.equal(result.dryRun, true);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(backups), false);
});

test("Narwhal context install quarantines append state and rollback restores both files", () => {
  const f = fixture();
  const release = build(f, "narwhal", "neutral-context");
  const target = join(f.root, "agent");
  const backups = join(f.root, "backups");
  write(join(target, "AGENTS.md"), "# Previous neutral context\n");
  write(join(target, "APPEND_SYSTEM.md"), "# Previous append layer\n");
  const installed = installRelease({
    manifestPath: join(release.output, "manifest.json"),
    payloadRoot: join(release.output, "payload"),
    targetRoot: target,
    backupRoot: backups,
    apply: true,
  });
  assert.equal(readFileSync(join(target, "AGENTS.md"), "utf8"), "# Neutral context\n");
  assert.equal(existsSync(join(target, "APPEND_SYSTEM.md")), false);
  assert.ok(installed.backupDir.includes("neutral-parity-"));
  const backup = JSON.parse(readFileSync(join(installed.backupDir, "backup.json"), "utf8"));
  assert.equal(backup.status, "installed");
  assert.ok(backup.touched.every((entry) => entry.previous?.some((item) => item.sha256)));

  const rolledBack = rollbackBackup({ backupDir: installed.backupDir, expectedTargetRoot: target });
  assert.equal(readFileSync(join(target, "AGENTS.md"), "utf8"), "# Previous neutral context\n");
  assert.equal(readFileSync(join(target, "APPEND_SYSTEM.md"), "utf8"), "# Previous append layer\n");
  assert.ok(rolledBack.displacedCurrent);
  assert.equal(readFileSync(join(rolledBack.displacedCurrent, "AGENTS.md"), "utf8"), "# Neutral context\n");
});

test("The-Sceptre capability install preserves context files byte-for-byte", () => {
  const f = fixture();
  const release = build(f, "sceptre", "capabilities");
  const target = join(f.root, "agent");
  const backups = join(f.root, "backups");
  write(join(target, "AGENTS.md"), "# Active context\n");
  write(join(target, "APPEND_SYSTEM.md"), "# Active append\n");
  write(join(target, "extensions", "alpha-compat.ts"), "export default 'stale';\n");
  installRelease({
    manifestPath: join(release.output, "manifest.json"),
    payloadRoot: join(release.output, "payload"),
    targetRoot: target,
    backupRoot: backups,
    apply: true,
  });
  assert.equal(readFileSync(join(target, "AGENTS.md"), "utf8"), "# Active context\n");
  assert.equal(readFileSync(join(target, "APPEND_SYSTEM.md"), "utf8"), "# Active append\n");
  assert.equal(readFileSync(join(target, "extensions", "alpha.ts"), "utf8"), "export default 'alpha';\n");
  assert.equal(existsSync(join(target, "extensions", "alpha-compat.ts")), false);
});

test("archive tampering fails immutable verification", () => {
  const f = fixture();
  const release = build(f, "narwhal", "capabilities");
  const archivePath = join(release.output, "release.tar");
  writeFileSync(archivePath, Buffer.concat([readFileSync(archivePath), Buffer.from("tampered")]));
  assert.throws(
    () => verifyRelease({ manifestPath: join(release.output, "manifest.json"), payloadRoot: join(release.output, "payload") }),
    /archive hash mismatch/,
  );
});

test("manifest tampering fails closed before installation", () => {
  const f = fixture();
  const release = build(f, "narwhal", "capabilities");
  const manifestPath = join(release.output, "manifest.json");
  writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")} `);
  assert.throws(
    () => installRelease({ manifestPath, payloadRoot: join(release.output, "payload"), targetRoot: join(f.root, "target"), apply: true }),
    /manifest hash mismatch/,
  );
});

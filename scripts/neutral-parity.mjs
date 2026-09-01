#!/usr/bin/env node
/** Backup-first, host-role-aware neutral Pi release tooling. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, readlinkSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

export const ROLES = new Set(["narwhal", "sceptre"]);
export const COMPONENTS = new Set(["capabilities", "neutral-context"]);
const FORMAT = "mypi-neutral-parity-v1";
const FORBIDDEN_PARTS = new Set([
  "secure_data", "secure-data", "secrets", ".env", "sessions", "session", "transcripts",
  "credentials", "cookies", "auth", "trust", "browser-state", "browser_state",
  "memory", "autobiography", "activation-records", "activation_records", "wren",
  ".pi", "build", "dist", "node_modules", "backup", "backups",
]);

function fail(message) { throw new Error(message); }
function slash(value) { return value.split(sep).join("/"); }
function canonical(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function hashBytes(value) { return createHash("sha256").update(value).digest("hex"); }
function hashFile(path) { return hashBytes(readFileSync(path)); }
function lexical(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function cleanRelative(value, label = "path") {
  if (typeof value !== "string" || !value || value.includes("\\") || posix.isAbsolute(value)) fail(`invalid ${label}: ${value}`);
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) fail(`unsafe ${label}: ${value}`);
  return normalized;
}
function inside(root, child) {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}
function targetPath(root, rel) {
  const result = resolve(root, ...cleanRelative(rel, "target").split("/"));
  if (!inside(root, result)) fail(`target escapes root: ${rel}`);
  return result;
}
function isForbidden(rel, role) {
  const lower = rel.toLowerCase();
  const parts = lower.split("/");
  if (parts.some((part) => FORBIDDEN_PARTS.has(part) || part.startsWith(".env.") || part.startsWith("wren-") || /^(?:auth|trust|credentials?|cookies?)(?:[._-]|$)/.test(part))) return "private/identity/session path";
  if (parts.some((part) => part.includes("dreamer") || part.includes("dream-cycle"))) return "Dreamer path";
  if (parts.some((part) => /(?:^|\.)test\.(?:[cm]?[jt]sx?)$/.test(part) || part === "tests" || part === "test")) return "test path";
  if (role === "narwhal" && parts.some((part) => part === "wayang" || part.startsWith("wayang-") || part.startsWith("wayang_"))) return "Wayang-on-Narwhal path";
  return undefined;
}
function assertAllowed(rel, role, label) {
  const reason = isForbidden(rel, role);
  if (reason) fail(`${label} ${rel} is forbidden: ${reason}`);
}
function assertNeutralContent(rel, bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail(`release artifact must be UTF-8 text: ${rel}`); }
  if (/\bwren\b/i.test(text)) fail(`release artifact contains Wren material: ${rel}`);
  if (/\bdreamer\b|\bdream[- ]cycle\b/i.test(text)) fail(`release artifact contains Dreamer material: ${rel}`);
}
function ensurePlainDirectory(path, label) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a real directory: ${path}`);
}
function assertNoSymlinkParents(root, path) {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel === ".") return;
  let current = resolve(root);
  const parts = rel.split(sep);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) fail(`managed path has an unsafe parent: ${current}`);
  }
}

export function readPolicy(path) {
  const raw = readFileSync(path);
  const policy = JSON.parse(raw);
  if (policy.format !== FORMAT || typeof policy.components !== "object") fail(`unsupported policy format in ${path}`);
  for (const [component, artifacts] of Object.entries(policy.components)) {
    if (!COMPONENTS.has(component) || !Array.isArray(artifacts)) fail(`invalid policy component: ${component}`);
    for (const artifact of artifacts) {
      cleanRelative(artifact?.source, "policy source"); cleanRelative(artifact?.target, "policy target");
      if (!Array.isArray(artifact.roles) || artifact.roles.length === 0 || artifact.roles.some((role) => !ROLES.has(role))) fail(`invalid roles for policy source: ${artifact.source}`);
    }
  }
  if (!Array.isArray(policy.sourceExclusions ?? [])) fail("sourceExclusions must be an array");
  for (const exclusion of policy.sourceExclusions ?? []) {
    cleanRelative(exclusion?.source, "excluded source");
    if (!Array.isArray(exclusion.roles) || exclusion.roles.length === 0 || exclusion.roles.some((role) => !ROLES.has(role)) || typeof exclusion.reason !== "string" || !exclusion.reason.trim()) fail(`invalid source exclusion: ${exclusion.source}`);
  }
  return { policy, bytes: raw, sha256: hashBytes(raw) };
}

function selectedArtifacts(policy, role, component) {
  if (!ROLES.has(role)) fail(`role must be one of: ${[...ROLES].join(", ")}`);
  if (!COMPONENTS.has(component)) fail(`component must be one of: ${[...COMPONENTS].join(", ")}`);
  const definitions = policy.components[component];
  if (!Array.isArray(definitions)) fail(`policy has no component: ${component}`);
  const selected = definitions.filter((item) => Array.isArray(item.roles) && item.roles.includes(role));
  if (selected.length === 0) fail(`component ${component} is not available for role ${role}`);
  return selected;
}

function walkFiles(root, rel = "") {
  const here = rel ? join(root, ...rel.split("/")) : root;
  const info = lstatSync(here);
  if (info.isSymbolicLink()) fail(`symlinks are not releasable: ${slash(relative(root, here)) || "."}`);
  if (info.isFile()) return [rel];
  if (!info.isDirectory()) fail(`unsupported source artifact: ${here}`);
  const files = [];
  for (const name of readdirSync(here).sort()) {
    const child = rel ? `${rel}/${name}` : name;
    files.push(...walkFiles(root, child));
  }
  return files;
}

export function createManifest({ policyPath, sourceRoot, role, component }) {
  const { policy, sha256: policySha256 } = readPolicy(policyPath);
  const source = resolve(sourceRoot);
  ensurePlainDirectory(source, "source root");
  const artifacts = selectedArtifacts(policy, role, component);
  const entries = [];
  const targets = new Set();
  for (const artifact of artifacts) {
    const sourceRel = cleanRelative(artifact.source, "source");
    const targetRel = cleanRelative(artifact.target, "target");
    assertAllowed(sourceRel, role, "source");
    assertAllowed(targetRel, role, "target");
    const sourcePath = targetPath(source, sourceRel);
    assertNoSymlinkParents(source, sourcePath);
    if (!existsSync(sourcePath)) fail(`allowlisted source is missing: ${sourceRel}`);
    const info = lstatSync(sourcePath);
    if (info.isSymbolicLink()) fail(`allowlisted source is a symlink: ${sourceRel}`);
    const children = info.isDirectory() ? walkFiles(sourcePath) : [""];
    for (const child of children) {
      const fileSourceRel = child ? `${sourceRel}/${child}` : sourceRel;
      const fileTargetRel = child ? `${targetRel}/${child}` : targetRel;
      assertAllowed(fileSourceRel, role, "source");
      assertAllowed(fileTargetRel, role, "target");
      if (targets.has(fileTargetRel)) fail(`duplicate manifest target: ${fileTargetRel}`);
      targets.add(fileTargetRel);
      const path = targetPath(source, fileSourceRel);
      assertNoSymlinkParents(source, path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`release entries must be regular files: ${fileSourceRel}`);
      const bytes = readFileSync(path);
      assertNeutralContent(fileSourceRel, bytes);
      entries.push({ source: fileSourceRel, target: fileTargetRel, hostApplicability: [...artifact.roles].sort(), mode: stat.mode & 0o777, size: stat.size, sha256: hashBytes(bytes) });
    }
  }
  entries.sort((a, b) => lexical(a.target, b.target));
  const quarantine = policy.quarantine?.[component]?.[role] ?? [];
  const protectedTargets = policy.protected?.[role] ?? [];
  for (const rel of [...quarantine, ...protectedTargets]) cleanRelative(rel, "policy target");
  for (const rel of quarantine) {
    if (targets.has(rel)) fail(`target cannot be installed and quarantined: ${rel}`);
  }
  for (const rel of protectedTargets) {
    if ([...targets].some((target) => target === rel || target.startsWith(`${rel}/`) || rel.startsWith(`${target}/`))) {
      fail(`manifest target overlaps protected ${role} path: ${rel}`);
    }
  }
  const manifest = {
    format: FORMAT,
    release: policy.release,
    role,
    component,
    policySha256,
    entries,
    quarantine: [...quarantine].sort(),
    protectedTargets: [...protectedTargets].sort(),
  };
  validateManifest(manifest);
  return manifest;
}

function validateManifest(manifest, { requireSourceCommit = false } = {}) {
  if (manifest.format !== FORMAT || !ROLES.has(manifest.role) || !COMPONENTS.has(manifest.component)) fail("invalid release manifest");
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.quarantine) || !Array.isArray(manifest.protectedTargets)) fail("invalid release manifest collections");
  if (requireSourceCommit && !/^[a-f0-9]{40,64}$/.test(manifest.sourceCommit ?? "")) fail("release manifest has no source commit");
  if (manifest.component === "neutral-context" && manifest.role !== "narwhal") fail("neutral context is Narwhal-only");
  const seen = new Set();
  for (const entry of manifest.entries) {
    const source = cleanRelative(entry?.source, "manifest source");
    const target = cleanRelative(entry?.target, "manifest target");
    assertAllowed(source, manifest.role, "manifest source");
    assertAllowed(target, manifest.role, "manifest target");
    if (seen.has(target)) fail(`duplicate manifest target: ${target}`);
    seen.add(target);
    if (!Array.isArray(entry.hostApplicability) || !entry.hostApplicability.includes(manifest.role) || entry.hostApplicability.some((role) => !ROLES.has(role))) fail(`invalid host applicability: ${target}`);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !Number.isInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail(`invalid manifest metadata: ${target}`);
  }
  for (const rel of [...manifest.quarantine, ...manifest.protectedTargets]) cleanRelative(rel, "manifest policy target");
  if (manifest.component === "capabilities" && [...seen].some((target) => target === "AGENTS.md" || target === "APPEND_SYSTEM.md")) fail("capabilities cannot install context paths");
  if (manifest.role === "sceptre" && [...seen].some((target) => target === "AGENTS.md" || target === "APPEND_SYSTEM.md")) fail("The-Sceptre context is protected");
  if (manifest.component === "neutral-context") {
    if (seen.size !== 1 || !seen.has("AGENTS.md") || !manifest.quarantine.includes("APPEND_SYSTEM.md")) fail("Narwhal neutral context must replace only AGENTS.md and quarantine APPEND_SYSTEM.md");
  }
  for (const rel of manifest.quarantine) if (seen.has(rel)) fail(`target cannot be installed and quarantined: ${rel}`);
}

function octal(value, width) { return `${value.toString(8).padStart(width - 1, "0")}\0`; }
function tarName(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const prefix = path.slice(0, i), name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  fail(`path is too long for deterministic ustar archive: ${path}`);
}
function tarHeader(path, size, mode) {
  const header = Buffer.alloc(512, 0);
  const names = tarName(path);
  header.write(names.name, 0, 100); header.write(octal(mode, 8), 100, 8);
  header.write(octal(0, 8), 108, 8); header.write(octal(0, 8), 116, 8);
  header.write(octal(size, 12), 124, 12); header.write(octal(0, 12), 136, 12);
  header.fill(0x20, 148, 156); header.write("0", 156, 1); header.write("ustar\0", 257, 6);
  header.write("00", 263, 2); header.write(names.prefix, 345, 155);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
  header.write(checksum, 148, 6); header[154] = 0; header[155] = 0x20;
  return header;
}
function deterministicTar(files) {
  const chunks = [];
  for (const file of files.sort((a, b) => lexical(a.path, b.path))) {
    chunks.push(tarHeader(file.path, file.bytes.length, file.mode), file.bytes);
    const remainder = file.bytes.length % 512;
    if (remainder) chunks.push(Buffer.alloc(512 - remainder, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function cleanGitCommit(sourceRoot) {
  const top = spawnSync("git", ["-C", sourceRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0 || resolve(top.stdout.trim()) !== resolve(sourceRoot)) fail("release source must be a Git worktree root");
  const status = spawnSync("git", ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  if (status.status !== 0 || status.stdout.length !== 0) fail("release source worktree must be clean");
  const commit = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (commit.status !== 0 || !/^[a-f0-9]{40,64}$/.test(commit.stdout.trim())) fail("could not determine release source commit");
  return commit.stdout.trim();
}
function requireTrackedReleaseInputs(sourceRoot, paths) {
  const tracked = spawnSync("git", ["-C", sourceRoot, "ls-files", "--error-unmatch", "--", ...paths], { encoding: "utf8" });
  if (tracked.status !== 0) fail("release policy and every allowlisted source file must be Git-tracked");
}

export function buildRelease({ policyPath, sourceRoot, role, component, outputDir }) {
  const output = resolve(outputDir);
  const source = resolve(sourceRoot);
  const policyAbsolute = resolve(policyPath);
  if (inside(source, output)) fail("release output must be outside the source worktree");
  if (!inside(source, policyAbsolute)) fail("release policy must be inside the source worktree");
  assertNoSymlinkParents(source, policyAbsolute);
  if (!lstatSync(policyAbsolute).isFile() || lstatSync(policyAbsolute).isSymbolicLink()) fail("release policy must be a regular tracked file");
  if (existsSync(output)) fail(`refusing to overwrite release output: ${output}`);
  const sourceCommit = cleanGitCommit(source);
  const unresolved = inventory({ policyPath, sourceRoot: source, role, component }).filter((entry) => entry.classification === "unresolved");
  if (unresolved.length > 0) fail(`release inventory has ${unresolved.length} unresolved source artifact(s); review the plan before building`);
  const manifest = { ...createManifest({ policyPath, sourceRoot: source, role, component }), sourceCommit };
  requireTrackedReleaseInputs(source, [slash(relative(source, resolve(policyPath))), ...manifest.entries.map((entry) => entry.source)]);
  const manifestBytes = Buffer.from(canonical(manifest));
  const manifestSha256 = hashBytes(manifestBytes);
  const payload = join(output, "payload");
  mkdirSync(payload, { recursive: true, mode: 0o700 });
  const tarFiles = [{ path: "manifest.json", bytes: manifestBytes, mode: 0o644 }];
  for (const entry of manifest.entries) {
    const bytes = readFileSync(targetPath(sourceRoot, entry.source));
    const destination = targetPath(payload, entry.target);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { mode: entry.mode });
    chmodSync(destination, entry.mode);
    tarFiles.push({ path: `payload/${entry.target}`, bytes, mode: entry.mode });
  }
  writeFileSync(join(output, "manifest.json"), manifestBytes, { mode: 0o644 });
  writeFileSync(join(output, "manifest.json.sha256"), `${manifestSha256}  manifest.json\n`, { mode: 0o644 });
  const archive = deterministicTar(tarFiles);
  writeFileSync(join(output, "release.tar"), archive, { mode: 0o644 });
  writeFileSync(join(output, "release.tar.sha256"), `${hashBytes(archive)}  release.tar\n`, { mode: 0o644 });
  verifyRelease({ manifestPath: join(output, "manifest.json"), payloadRoot: payload });
  return { manifest, manifestSha256, archiveSha256: hashBytes(archive), output };
}

function verifyHashedFile(path, label) {
  if (!existsSync(path)) fail(`${label} is required: ${path}`);
  const sidecar = `${path}.sha256`;
  if (!existsSync(sidecar)) fail(`${label} hash sidecar is required: ${sidecar}`);
  const sha256 = hashFile(path);
  const expected = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== sha256) fail(`${label} hash mismatch: ${path}`);
  return { bytes: readFileSync(path), sha256 };
}

export function loadManifest(manifestPath) {
  const { bytes, sha256 } = verifyHashedFile(manifestPath, "manifest");
  const manifest = JSON.parse(bytes);
  validateManifest(manifest, { requireSourceCommit: true });
  return { manifest, sha256 };
}

export function verifyRelease({ manifestPath, payloadRoot, targetRoot, requireQuarantine = false }) {
  const { manifest, sha256 } = loadManifest(manifestPath);
  const archive = join(dirname(manifestPath), "release.tar");
  const { sha256: archiveSha256 } = verifyHashedFile(archive, "release archive");
  if (!targetRoot && !payloadRoot) fail("payloadRoot or targetRoot is required");
  const root = resolve(targetRoot ?? payloadRoot);
  ensurePlainDirectory(root, targetRoot ? "target root" : "payload root");
  for (const entry of manifest.entries) {
    assertAllowed(entry.target, manifest.role, "manifest target");
    const path = targetPath(root, entry.target);
    assertNoSymlinkParents(root, path);
    if (!existsSync(path)) fail(`missing manifest entry: ${entry.target}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`manifest entry is not a regular file: ${entry.target}`);
    if (stat.size !== entry.size || hashFile(path) !== entry.sha256 || (stat.mode & 0o777) !== entry.mode) fail(`manifest drift: ${entry.target}`);
  }
  if (requireQuarantine || targetRoot) {
    for (const rel of manifest.quarantine) if (existsSync(targetPath(root, rel))) fail(`quarantined target is still present: ${rel}`);
  }
  const expectedArchive = deterministicTar([
    { path: "manifest.json", bytes: readFileSync(manifestPath), mode: 0o644 },
    ...manifest.entries.map((entry) => ({ path: `payload/${entry.target}`, bytes: readFileSync(targetPath(root, entry.target)), mode: entry.mode })),
  ]);
  if (hashBytes(expectedArchive) !== archiveSha256) fail("release archive content does not match manifest and payload");
  return { role: manifest.role, component: manifest.component, entries: manifest.entries.length, manifestSha256: sha256, archiveSha256 };
}

function pathDescription(path, rel = "") {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return [{ path: rel, type: "symlink", target: readlinkSync(path) }];
  if (info.isFile()) return [{ path: rel, type: "file", mode: info.mode & 0o777, size: info.size, sha256: hashFile(path) }];
  if (!info.isDirectory()) fail(`unsupported existing target type: ${path}`);
  const result = [{ path: rel, type: "directory", mode: info.mode & 0o777 }];
  for (const name of readdirSync(path).sort()) result.push(...pathDescription(join(path, name), rel ? `${rel}/${name}` : name));
  return result;
}
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function writeState(path, state) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, canonical(state), { mode: 0o600 });
  renameSync(temp, path);
}
function movePath(from, to) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  renameSync(from, to);
}
function touchedTargets(manifest) {
  const targets = [...manifest.entries.map((entry) => entry.target), ...manifest.quarantine];
  const unique = [...new Set(targets)].sort();
  for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) {
    if (unique[j].startsWith(`${unique[i]}/`)) fail(`nested managed targets are not allowed: ${unique[i]} and ${unique[j]}`);
  }
  return unique;
}

export function installRelease({ manifestPath, payloadRoot, targetRoot, backupRoot, apply = false }) {
  const verified = verifyRelease({ manifestPath, payloadRoot });
  const { manifest, sha256 } = loadManifest(manifestPath);
  const target = resolve(targetRoot);
  const payload = resolve(payloadRoot);
  const backups = resolve(backupRoot ?? join(dirname(target), ".neutral-parity-backups"));
  if (inside(target, payload) || inside(payload, target)) fail("payload and target roots must not overlap");
  if (inside(target, backups)) fail("backup root must not be inside the managed target root");
  const touched = touchedTargets(manifest);
  const plan = touched.map((rel) => ({ target: rel, action: manifest.quarantine.includes(rel) ? "backup-and-quarantine" : "backup-and-install" }));
  if (!apply) return { dryRun: true, ...verified, plan };
  if (!existsSync(target)) mkdirSync(target, { recursive: true, mode: 0o700 });
  ensurePlainDirectory(target, "target root");
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  ensurePlainDirectory(backups, "backup root");
  if (statSync(target).dev !== statSync(backups).dev) fail("backup root must be on the same filesystem as target root for recoverable atomic moves");
  const backupDir = join(backups, `neutral-parity-${timestamp()}-${manifest.role}-${manifest.component}-${process.pid}`);
  mkdirSync(backupDir, { recursive: false, mode: 0o700 });
  const statePath = join(backupDir, "backup.json");
  const state = { format: FORMAT, status: "preparing", role: manifest.role, component: manifest.component, manifestSha256: sha256, targetRoot: target, touched: [] };
  writeState(statePath, state);
  try {
    for (const rel of touched) {
      const current = targetPath(target, rel);
      assertNoSymlinkParents(target, current);
      const previous = targetPath(join(backupDir, "previous"), rel);
      const record = { target: rel, existed: existsSync(current), previous: null };
      if (record.existed) {
        if (lstatSync(current).isDirectory()) fail(`managed file target is unexpectedly a directory: ${rel}`);
        record.previous = pathDescription(current);
        movePath(current, previous);
        if (canonical(pathDescription(previous)) !== canonical(record.previous)) fail(`backup verification failed: ${rel}`);
      }
      state.touched.push(record); writeState(statePath, state);
    }
    for (const entry of manifest.entries) {
      const source = targetPath(payloadRoot, entry.target);
      const destination = targetPath(target, entry.target);
      const staging = `${destination}.neutral-parity-${process.pid}`;
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, staging); chmodSync(staging, entry.mode); renameSync(staging, destination);
    }
    verifyRelease({ manifestPath, targetRoot: target });
    state.status = "installed"; state.installedAt = new Date().toISOString(); writeState(statePath, state);
    return { dryRun: false, backupDir, ...verified };
  } catch (error) {
    state.status = "install-failed"; state.error = String(error?.message ?? error); writeState(statePath, state);
    rollbackBackup({ backupDir, expectedTargetRoot: target });
    throw error;
  }
}

export function rollbackBackup({ backupDir, expectedTargetRoot }) {
  const backup = resolve(backupDir);
  const statePath = join(backup, "backup.json");
  const state = JSON.parse(readFileSync(statePath));
  if (state.format !== FORMAT || !Array.isArray(state.touched)) fail("invalid backup metadata");
  const target = resolve(expectedTargetRoot ?? state.targetRoot);
  if (target !== resolve(state.targetRoot)) fail("rollback target does not match backup metadata");
  const displacedRoot = join(backup, `rollback-current-${timestamp()}-${process.pid}`);
  for (const record of [...state.touched].reverse()) {
    const current = targetPath(target, record.target);
    assertNoSymlinkParents(target, current);
    if (existsSync(current)) movePath(current, targetPath(displacedRoot, record.target));
    if (record.existed) {
      const previous = targetPath(join(backup, "previous"), record.target);
      if (!existsSync(previous)) fail(`rollback backup is missing: ${record.target}`);
      if (canonical(pathDescription(previous)) !== canonical(record.previous)) fail(`rollback backup hash mismatch: ${record.target}`);
      movePath(previous, current);
    }
  }
  state.status = "rolled-back"; state.rolledBackAt = new Date().toISOString(); state.displacedCurrent = existsSync(displacedRoot) ? displacedRoot : null;
  writeState(statePath, state);
  return { targetRoot: target, displacedCurrent: state.displacedCurrent };
}

function inventoryFiles(sourceRoot, roots, role) {
  const results = [];
  for (const rootRel of roots ?? []) {
    const root = targetPath(sourceRoot, cleanRelative(rootRel, "inventory root"));
    if (!existsSync(root)) continue;
    ensurePlainDirectory(root, "inventory root");
    for (const child of walkFiles(root)) {
      const path = targetPath(root, child);
      const info = lstatSync(path);
      const releasePath = `${rootRel}/${child}`;
      const reason = isForbidden(releasePath, role);
      results.push({ path: releasePath, mode: info.mode & 0o777, size: info.size, sha256: reason === "private/identity/session path" ? null : hashFile(path) });
    }
  }
  return results.sort((a, b) => lexical(a.path, b.path));
}
export function inventory({ policyPath, sourceRoot, role, component }) {
  const { policy } = readPolicy(policyPath);
  selectedArtifacts(policy, role, component); // Validate that this role/component exists.
  const included = Object.values(policy.components).flat().filter((entry) => entry.roles?.includes(role));
  const policyExclusions = (policy.sourceExclusions ?? []).filter((entry) => entry.roles?.includes(role));
  return inventoryFiles(sourceRoot, policy.inventoryRoots, role).map((candidate) => {
    const match = included.find((entry) => candidate.path === entry.source || candidate.path.startsWith(`${entry.source}/`));
    const hardExcluded = isForbidden(candidate.path, role);
    const policyExcluded = policyExclusions.find((entry) => candidate.path === entry.source || candidate.path.startsWith(`${entry.source}/`));
    return {
      ...candidate,
      classification: match ? (match.roles.length === ROLES.size ? "include" : "host-specific") : hardExcluded || policyExcluded ? "excluded" : "unresolved",
      hostApplicability: match ? [...match.roles].sort() : policyExcluded ? [...policyExcluded.roles].sort() : [],
      reason: hardExcluded ?? policyExcluded?.reason,
    };
  });
}

function deploymentClassification(manifest) {
  return [
    ...manifest.entries.map((entry) => ({ path: entry.target, classification: entry.hostApplicability.length === ROLES.size ? "include" : "host-specific", hostApplicability: entry.hostApplicability })),
    ...manifest.quarantine.map((path) => ({ path, classification: "stale-residue", hostApplicability: [manifest.role] })),
    ...manifest.protectedTargets.map((path) => ({ path, classification: "excluded", hostApplicability: [manifest.role], reason: "host context is protected" })),
  ].sort((a, b) => lexical(a.path, b.path));
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--apply") options.apply = true;
    else if (value.startsWith("--")) {
      const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) fail(`missing value for ${value}`);
      options[key] = argv[++i];
    } else fail(`unexpected argument: ${value}`);
  }
  return options;
}
function required(options, key) { if (!options[key]) fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`); return options[key]; }

export async function main(argv = process.argv.slice(2)) {
  const command = argv.shift();
  const options = parseArgs(argv);
  let result;
  if (command === "plan") {
    const args = { policyPath: required(options, "policy"), sourceRoot: required(options, "source"), role: required(options, "role"), component: required(options, "component") };
    const manifest = createManifest(args);
    result = { manifest, sourceInventory: inventory(args), targetClassifications: deploymentClassification(manifest) };
  } else if (command === "build") result = buildRelease({ policyPath: required(options, "policy"), sourceRoot: required(options, "source"), role: required(options, "role"), component: required(options, "component"), outputDir: required(options, "output") });
  else if (command === "verify") result = verifyRelease({ manifestPath: required(options, "manifest"), payloadRoot: options.payload, targetRoot: options.target });
  else if (command === "install") result = installRelease({ manifestPath: required(options, "manifest"), payloadRoot: required(options, "payload"), targetRoot: required(options, "target"), backupRoot: options.backupRoot, apply: options.apply });
  else if (command === "rollback") result = rollbackBackup({ backupDir: required(options, "backup"), expectedTargetRoot: options.target });
  else fail("usage: neutral-parity.mjs <plan|build|verify|install|rollback> [options]");
  process.stdout.write(canonical(result));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => { process.stderr.write(`neutral-parity: ${error.message}\n`); process.exitCode = 1; });
}

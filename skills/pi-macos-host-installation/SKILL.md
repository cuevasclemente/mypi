---
name: pi-macos-host-installation
description: >-
  Install, migrate, and troubleshoot Pi on macOS hosts with secret-safe SSH access, Homebrew and fish PATH repair, supported Node/Pi setup, backup-first allowlisted mypi context distribution, macOS/BSD portability checks, protected OAuth handoff, runtime validation, and rollback.
---

# Pi macOS Host Installation

Bootstrap a Mac as a Pi host without treating it like Linux. Use `pi-extension-distribution` for the generic source-to-runtime packaging model; this skill covers the macOS-specific access, shell, package, portability, activation, validation, and recovery work.

## Setup

Confirm the intended host, macOS account, architecture, shell, canonical mypi source, and desired context scope before mutation. Typical paths are:

```text
Remote Pi home:       /Users/<user>/.pi/agent
Remote mypi snapshot: /Users/<user>/src/mypi
Canonical source:     ~/src/mypi
Apple Silicon brew:   /opt/homebrew
Intel brew:           /usr/local
```

Required boundaries:

- Never read, print, transmit, or copy private keys, passwords, OAuth tokens, cookies, PINs, `auth.json` values, `.env` values, `secure_data`, or credential-store contents.
- Treat `settings.json` and `models.json` as potentially secret-bearing. Preserve them unless a reviewed, non-secret targeted change is required.
- Preserve `auth.json`, settings, models, sessions, trust state, and unrelated local files. Metadata checks such as existence, owner, mode, size, and path are allowed; content inspection is not.
- Do not alter the remote host until SSH authentication works and the user has approved the install scope.
- Prefer copied runtime artifacts on a remote host. Use symlinks only when their source lifetime and update model are deliberate.
- Do not run mypi's broad `make install-all` unreviewed on macOS. It may contain GNU `find`, destructive replacement, Linux paths, cron, or systemd assumptions.

## Workflow

### 1. Separate SSH reachability from authentication

Test noninteractively so a prompt cannot capture a password:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 <host> true
```

Interpret failures precisely:

- timeout, DNS failure, or no route: reachability problem;
- host-key warning: identity/trust problem; verify the new fingerprint out of band and preserve valid multi-boot keys rather than deleting them blindly;
- `Permission denied (publickey,keyboard-interactive)`: the host is reachable but authentication failed;
- success: authentication and command execution work.

If auth fails, ask the user to enable macOS Remote Login or authorize an existing **public** key through a protected/manual route. Never request a password or private key in chat. Public-key filenames and fingerprints may be inventoried without reading private material. Retry with `BatchMode=yes` after the user completes the handoff.

Remote SSH may invoke fish. Do not send a long POSIX script and assume bash parses it. For multi-step probes, explicitly select bash:

```bash
ssh <host> /bin/bash -s <<'REMOTE'
set -euo pipefail
hostname
id -un
uname -srm
printf 'shell=%s\n' "$SHELL"
REMOTE
```

### 2. Inventory only non-secret state

Before changing anything, record:

- `sw_vers`, `uname -m`, account/home, login shell, and `$PATH`;
- locations and versions of `brew`, `node`, `npm`, `pi`, `git`, `fish`, and `/bin/bash`;
- whether `~/.pi/agent`, `~/src/mypi`, and managed runtime paths exist;
- owner/mode/size/timestamp metadata for existing Pi files, especially `auth.json`, without opening them;
- existing extensions, skills, agents, teams, and hooks by path/name only;
- filesystem free space and whether Homebrew's prefix is user-writable.

Probe both common Homebrew prefixes even when `command -v` fails:

```bash
for p in /opt/homebrew/bin/brew /opt/homebrew/bin/node /opt/homebrew/bin/npm \
         /usr/local/bin/brew /usr/local/bin/node /usr/local/bin/npm; do
  test -x "$p" && "$p" --version 2>/dev/null | head -n 1
done
```

A missing command on noninteractive SSH `PATH` does not prove the package is absent.

### 3. Repair Homebrew and fish PATH safely

Choose the prefix from the architecture and actual executable locations; do not assume `/opt/homebrew` on Intel. Back up an existing fish fragment before changing it. For Apple Silicon fish, a dedicated fragment is predictable in interactive and noninteractive shells:

```fish
# ~/.config/fish/conf.d/10-homebrew-path.fish
fish_add_path /opt/homebrew/bin /opt/homebrew/sbin
```

Use `/usr/local/bin` and `/usr/local/sbin` for an Intel Homebrew installation. Avoid repeatedly appending duplicate `export PATH=...` lines to `config.fish`.

Validate from fresh shells and SSH:

```bash
/opt/homebrew/bin/fish -lc 'command -v brew node npm; node --version; npm --version'
ssh <host> 'command -v node; command -v npm'
```

If fish is not the login shell, configure the shell actually used. Do not replace the user's shell merely to make Pi work.

### 4. Install a supported Node and Pi

Check the current package requirement rather than copying a historical Node minimum:

```bash
npm view @earendil-works/pi-coding-agent@latest engines --json
node --version
npm --version
```

If Node is absent, install only Node with Homebrew. If it is present but unsupported, propose a Node-only upgrade and get approval; do not run a blanket `brew upgrade`. Then use Pi's documented npm install path:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

`--ignore-scripts` follows Pi's documented normal npm install and reduces lifecycle-script exposure. Pin a Pi version only when reproducibility or compatibility requires it, and record the pin. Verify the resolved binaries and versions from a fresh fish shell and a fresh SSH command. Do not infer success from npm's exit code alone.

### 5. Build a macOS compatibility allowlist

Inventory mypi source without entering marked secret directories. Classify each artifact as:

1. portable;
2. portable but dependent on an optional CLI/service/model;
3. Linux/systemd-only;
4. host-specific;
5. secret-dependent;
6. test/generated/non-runtime.

Review extension entrypoints and every co-located relative import. Copy a whole extension directory when `index.ts` imports sibling helpers. Exclude tests accidentally matched by `*.ts`, generated outputs, Linux schedulers, and extensions that directly require an unavailable secret or host-specific endpoint. A Linux/server **skill** may still be useful context when the Mac administers remote infrastructure; distinguish inert Markdown guidance from executable host integration.

Create an explicit source-to-target manifest for:

| Canonical source | Runtime target |
|---|---|
| `agent-context/AGENTS.md` | `~/.pi/agent/AGENTS.md` |
| approved hooks template | `~/.pi/agent/hooks.json` |
| approved `plugins/<name>.ts` or directory | `~/.pi/agent/extensions/...` |
| approved `skills/<name>/` | `~/.pi/agent/skills/<name>/` |
| approved `.pi/agents/*.md` | `~/.pi/agent/agents/` |
| approved `.pi/teams/*.md` | `~/.pi/agent/teams/` |

Install `APPEND_SYSTEM.md`, identity material, prompts, or themes only when separately included in the approved manifest. Do not install the repository-root `AGENTS.md` as global context when `agent-context/AGENTS.md` is canonical.

### 6. Back up before transfer or activation

Create a collision-resistant, exact backup directory and print its path:

```bash
backup="$HOME/.pi/backups/pi-macos-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$backup"
chmod 700 "$HOME/.pi/backups" "$backup"
```

Back up every managed target plus the prior `~/src/mypi` snapshot with metadata-preserving macOS tools such as `ditto`. Create `<name>.absent` markers when a target did not exist. Record a manifest containing source path, target path, type, mode, and checksum. Never choose a rollback source by “latest”; retain the exact printed path.

The backup may preserve an existing secret-bearing Pi directory opaquely, but do not archive it into mypi, Memoriki, chat, or a shared location. Limit rollback operations to managed paths; auth/settings/sessions remain untouched unless the user explicitly requests their recovery.

### 7. Stage an allowlisted mypi snapshot

Transfer only listed paths, using an explicit tar list or `rsync --files-from`; broad “copy everything, exclude a few names” logic is easier to get wrong. At minimum exclude:

```text
.git/
node_modules/
secure_data/
.env*
auth.json
credential/token/cookie/key files
session and coordination state
full Memoriki/raw archives
```

Do not copy `.mcp.json`, `models.json`, or settings merely because they exist; first prove they are non-secret and approved. Preserve the remote auth/config files already in `~/.pi/agent`.

Stage the source under a temporary directory on the target and construct parallel temporary runtime roots for extensions, skills, agents, and teams. Validate staging before activation. Activate with same-filesystem renames where possible; move displaced managed roots into the exact backup/holding directory. Avoid `rm -rf` and avoid leaving stale excluded extensions active.

Private context can use directories `0700` and files `0600`; preserve executable bits only for reviewed scripts that need them. Confirm ownership remains the target user.

### 8. Respect macOS/BSD command differences

Common Linux assumptions that need replacement:

| Linux/GNU pattern | macOS-safe approach |
|---|---|
| `find -printf`, `-mindepth`, `-maxdepth` | shell globs or a small Node/Python inventory script |
| `stat -c ...` | `stat -f ...` |
| `date -Iseconds` | `date -u +%Y-%m-%dT%H:%M:%SZ` |
| `sha256sum` | `shasum -a 256` |
| `sed -i` | `sed -i ''` or write a new file |
| `cp -a` | `ditto` or tested `cp -R -p` |
| `readlink -f` | avoid it or use a tested language helper |
| `xargs -r` | guard empty input explicitly |
| systemd user units | design a separate `launchd` workflow if scheduling is requested |

GNU utilities installed by Homebrew do not make stock BSD commands portable. Use the commands available in a fresh target shell.

### 9. Protected OAuth and login handoff

Configuration installation and provider authentication are separate phases. After non-secret runtime validation, ask the user to sit at the Mac or use another protected interactive terminal and run:

```text
pi
/login
```

The user chooses the provider and completes browser login, MFA, device confirmation, or API-key entry directly. Pause while this happens. Never ask the user to paste a token, authorization code, cookie, password, or recovery code into chat, and never automate secret entry through agent-visible tools.

After the user says login is complete, perform behavior-only checks:

```bash
pi --list-models <provider>
```

Then have the user select the intended model and run a harmless `Say ok` prompt. Do not inspect `auth.json`; only verify its owner/mode metadata if needed. Preserve unrelated default-model and shell settings when making a targeted non-secret settings change.

## Validation

Run all applicable checks before declaring success.

### Static structure

- `pi --version`, `node --version`, `npm --version`, and resolved paths work in fresh fish, bash, and SSH contexts that the user will use.
- Managed counts match the install manifest; every extension directory has an `index.ts` entrypoint.
- Hooks and other known non-secret JSON parse without printing their contents:

```bash
node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.pi/agent/hooks.json","utf8")); console.log("hooks JSON OK")'
```

- Validate all skill frontmatter with the `yaml` dependency installed alongside Pi:

```bash
PI_ROOT="$(npm root -g)"
node - "$PI_ROOT" "$HOME/.pi/agent/skills" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const piRoot = process.argv[2];
const skillRoot = process.argv[3];
const YAML = require(require.resolve('yaml', { paths: [piRoot] }));
const errors = [];
for (const dir of fs.readdirSync(skillRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const file = path.join(skillRoot, dir.name, 'SKILL.md');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const end = text.indexOf('\n---', 4);
  if (!text.startsWith('---\n') || end < 0) { errors.push(`${file}: malformed frontmatter`); continue; }
  try {
    const fm = YAML.parse(text.slice(4, end));
    if (!fm?.name || !fm?.description) errors.push(`${file}: missing name/description`);
    if (fm?.name !== dir.name) errors.push(`${file}: name does not match directory`);
  } catch (e) { errors.push(`${file}: ${e.message}`); }
}
console.log(`frontmatter_errors=${errors.length}`);
for (const e of errors) console.log(e);
process.exit(errors.length ? 1 : 0);
NODE
```

### Identity, drift, links, and permissions

- Byte-compare global context and hooks to their approved staged sources with `cmp`.
- Recompute manifest checksums with `shasum -a 256`.
- Compare already-shaped source/staging roots to runtime with `rsync -rcn --delete`; any output is drift to explain. Never use a broad destructive `--delete` activation.
- Check for unintended links:

```bash
find ~/.pi/agent/extensions ~/.pi/agent/skills ~/.pi/agent/agents ~/.pi/agent/teams -type l -print
```

- Inspect ownership and modes with macOS `stat`:

```bash
stat -f '%Sp %Su:%Sg %N' ~/.pi/agent/AGENTS.md ~/.pi/agent/hooks.json
```

- Assert excluded/test/secret-dependent extensions are absent from the active runtime and `secure_data` was not transferred.

### Runtime and models

Establish a baseline, then load the installed runtime:

```bash
pi --no-extensions --list-models
pi --list-models
pi --list-models <expected-provider>
```

Capture startup warnings without exposing credentials. Confirm expected extension commands/tools in an interactive session, for example hooks, todo, teams, coordination, and model-provider commands. Optional integrations may load but remain unavailable until their public dependency or user-owned authentication is configured; report that as a dependency gap, not an install failure.

### Rollback readiness

Before handoff, verify:

- the exact backup directory exists and is mode `0700`;
- its manifest and absent markers cover every managed target;
- auth/settings/sessions were not part of the replacement set;
- the restore sequence is documented and does not guess a backup path.

## Backup and rollback

If startup fails or validation finds unexplained drift:

1. Stop activation and preserve the failed staged/runtime tree in a timestamped holding directory.
2. Select the exact backup path printed during this install.
3. For each managed path, preserve its failed current state, then restore the saved copy with `ditto`; if the backup has an `.absent` marker, move the current path aside rather than permanently deleting it.
4. Restore the prior fish PATH fragment if this install changed it.
5. Reinstall the prior pinned Pi version only if Pi itself caused the regression; do not roll back Node or Homebrew broadly.
6. Re-run JSON/frontmatter, links, permissions, startup, and model-list checks.
7. Keep `auth.json`, settings, models, sessions, and user data untouched unless the rollback manifest explicitly and safely includes them.

## Examples

### Fresh Apple Silicon Mac with fish

1. `BatchMode=yes` SSH succeeds.
2. `/opt/homebrew/bin/node` exists but `node` is absent from SSH `PATH`.
3. Back up and add `~/.config/fish/conf.d/10-homebrew-path.fish`.
4. Verify Pi's current Node engine, install Pi with npm `--ignore-scripts`, and check fresh-shell resolution.
5. Audit mypi, stage only approved extensions/context, activate copied runtime roots, validate, then hand OAuth to the user.

### Existing Pi home with working login

1. Inventory `auth.json`, settings, and sessions by metadata only.
2. Back up managed runtime roots and global context; do not replace auth/config/session files.
3. Stage and atomically activate extensions, skills, agents, teams, hooks, and `AGENTS.md`.
4. Compare drift and run startup/model listing. Existing login should continue to work without credential migration.

## Tools and techniques

- `read`: inspect Pi docs, mypi source, extension imports, and non-secret manifests.
- `ssh -o BatchMode=yes`: distinguish network access from protected authentication.
- `/bin/bash -s` over SSH: avoid fish parsing POSIX deployment scripts.
- `stat -f`, `ditto`, `shasum -a 256`, guarded `find`, and dry-run `rsync`: macOS-safe metadata, copy, hash, and drift checks.
- Node scripts: portable inventory, JSON validation, and Agent Skills YAML parsing without GNU shell assumptions.
- Staging directories, absent markers, checksummed allowlists, and same-filesystem renames: recoverable activation.
- Interactive human handoff: OAuth, MFA, CAPTCHA, passkeys, passwords, and any other protected input.

---
name: pi-windows-host-installation
description: >-
  Install and troubleshoot pi on Windows hosts with secret-safe setup: portable Node when system Node is too old, npm/PowerShell shims, Git Bash shellPath, mypi extension and skill distribution, YAML frontmatter validation, and OAuth/default-model handoff without reading credentials.
---

# Pi Windows Host Installation

Use this skill when Clemente wants `pi` installed or repaired on a Windows machine, especially a host reached over SSH such as `frost-walrus`. It covers the practical Windows-specific pieces that differ from Linux: Node version conflicts, PowerShell shims, Git Bash shell execution, and secret-safe provider setup.

## Setup

- Access to the Windows host, typically SSH into Git Bash or PowerShell.
- A Node.js version supported by the current pi package. Check pi docs/package requirements; in the source session pi `0.80.3` required Node `>=22.19.0`.
- `npm` available under the chosen Node runtime.
- Source repo for Clemente's personal pi setup, usually `~/src/mypi` on the Linux side.
- Do **not** read, print, or copy secret values. Treat `auth.json`, token files, PIN files, `.env`, `secure_data`, and private keys as opaque.

Useful Windows paths:

```text
C:\Users\<user>\.pi\agent\
C:\Users\<user>\.pi\agent\extensions\
C:\Users\<user>\.pi\agent\skills\
C:\Users\<user>\src\mypi\
C:\Users\<user>\apps\node-v<version>-win-x64\
C:\Users\<user>\AppData\Roaming\npm\pi.cmd
C:\Users\<user>\AppData\Roaming\npm\pi.ps1
```

## Workflow

### 1. Identify the shell and current runtime

From the remote host, check what Windows will actually execute:

```powershell
Get-Command pi -All
node --version
npm --version
pi --version
```

If working through SSH into Git Bash, also verify:

```bash
hostname
which node || true
node --version || true
which pi || true
pi --version || true
```

A common failure pattern is PowerShell resolving an old AppData npm shim that uses an outdated system Node. In the source session, pi failed with an Undici/WebIDL error because the shim used Node `v20.12.0` while pi required Node 22.

### 2. Prefer portable Node when system Node is too old

Avoid changing system-wide Windows Node unless Clemente asks. Install or unpack a portable Node release under the user profile, for example:

```text
C:\Users\<user>\apps\node-v22.23.1-win-x64\node.exe
```

Then run npm using that Node environment and install pi globally under the user's npm-global prefix:

```powershell
$env:PATH="C:\Users\<user>\apps\node-v22.23.1-win-x64;C:\Users\<user>\.npm-global;C:\Users\<user>\.npm-global\bin;$env:PATH"
npm install -g @earendil-works/pi-coding-agent
pi --version
```

### 3. Stage Clemente's `mypi` without secrets

Copy `~/src/mypi` to the Windows host, excluding heavy or secret-bearing directories:

- exclude `.git`
- exclude `node_modules`
- exclude `secure_data`
- exclude coordination/session state such as `.pi/coordination` if present
- exclude credential/token files unless Clemente explicitly performs an opaque transfer

Target path:

```text
C:\Users\<user>\src\mypi
```

Use recoverable backups for any existing remote pi config before replacing files.

### 4. Install extensions, skills, hooks, and context

Populate the Windows pi agent directory:

```text
C:\Users\<user>\.pi\agent\extensions\
C:\Users\<user>\.pi\agent\skills\
C:\Users\<user>\.pi\agent\hooks.json
C:\Users\<user>\.pi\agent\AGENTS.md
```

Keep Clemente's three skill surfaces synchronized when editing skill files:

```text
~/.pi/agent/skills/<skill>/SKILL.md
~/src/mypi/skills/<skill>/SKILL.md
~/src/memoriki/skills/<skill>/SKILL.md
```

If syncing fixes to the remote host, update both:

```text
C:\Users\<user>\src\mypi\skills\<skill>\SKILL.md
C:\Users\<user>\.pi\agent\skills\<skill>\SKILL.md
```

### 5. Set a Windows-safe shell path

For pi's bash-oriented tool commands on Windows, set `shellPath` to Git Bash when available:

```text
C:\Program Files\Git\bin\bash.exe
```

Preserve existing settings when editing `settings.json`; do not overwrite the entire file blindly. Avoid printing secret-bearing settings files. If command guard blocks metadata reads, set only the required key through a small script that does not echo the full file.

### 6. Repair PowerShell/npm shims when they point at the wrong Node

If `Get-Command pi -All` shows AppData npm shims before the intended pi binary, back them up and replace wrappers so they explicitly invoke portable Node and pi's CLI entrypoint:

```text
C:\Users\<user>\AppData\Roaming\npm\pi.cmd
C:\Users\<user>\AppData\Roaming\npm\pi.ps1
C:\Users\<user>\AppData\Roaming\npm\pi
```

The wrappers should call:

```text
C:\Users\<user>\apps\node-v22.23.1-win-x64\node.exe
C:\Users\<user>\.npm-global\node_modules\@earendil-works\pi-coding-agent\dist\cli.js
```

Then validate from a fresh PowerShell window:

```powershell
Get-Command pi -All
pi --version
node --version
```

### 7. Validate skill YAML before handoff

Windows installs can fail if any installed skill has invalid frontmatter. Parse all local and remote `SKILL.md` files after syncing.

Common source-session fix: quote or fold `description:` values that contain `: `, because unquoted colons can trigger YAML errors such as `Nested mappings are not allowed in compact mappings`.

Example local validation:

```bash
python - <<'PY'
from pathlib import Path
import yaml
roots = [Path.home()/'.pi/agent/skills', Path.home()/'src/mypi/skills', Path.home()/'src/memoriki/skills']
errors = []
for root in roots:
    for p in root.glob('*/SKILL.md'):
        text = p.read_text(encoding='utf-8')
        if not text.startswith('---'):
            continue
        fm = text.split('---', 2)[1]
        try:
            yaml.safe_load(fm)
        except Exception as e:
            errors.append((str(p), str(e)))
print(f'errors={len(errors)}')
for path, err in errors:
    print(path, err)
raise SystemExit(1 if errors else 0)
PY
```

### 8. Handle OAuth and default models secret-safely

Provider setup often needs both non-secret model config and secret OAuth credentials:

- Non-secret model registry/settings can be created or edited, preserving existing settings such as `shellPath`.
- `auth.json` is secret-bearing. Do not read, print, or copy it directly in an agent transcript.
- Prefer asking Clemente to run:

```powershell
pi /login openai-codex
```

or to perform a manual opaque copy into:

```text
C:\Users\<user>\.pi\agent\auth.json
```

Validation should be behavior-only:

```powershell
pi --list-models openai-codex
pi --model openai-codex/gpt-5.5 -p "Say ok"
```

## Validation checklist

- `pi --version` succeeds in both Git Bash/SSH and fresh PowerShell.
- `node --version` used by the shim meets pi's minimum requirement.
- `Get-Command pi -All` resolves to the intended wrappers.
- `shellPath` points to Git Bash if bash tools are expected.
- Installed skills parse as YAML with zero frontmatter errors.
- `pi --list-models <provider>` works after model/provider setup.
- OAuth credentials are either set by user login or manually copied opaquely by Clemente, not read by the agent.
- Any modified skills are synced across installed pi context, `~/src/mypi`, and `~/src/memoriki`.

## Troubleshooting patterns

- **`webidl.util.markAsUncloneable is not a function`**: likely old Node executing pi. Replace AppData shims or PATH so portable Node 22+ is used.
- **`No models matching openai-codex`**: model registry not installed/loaded or OAuth provider unavailable. Check non-secret `models.json` setup and then login/opaque auth handoff.
- **Skill parse crash at startup**: run frontmatter validation; quote/fold descriptions containing colons.
- **Bash commands fail on Windows**: verify `shellPath` points to Git Bash and that the path is preserved in settings.

## Journal and handoff

For substantial host installs, write a project journal with:

- host name and access method
- Node/pi versions and install paths
- files copied or excluded
- shim backups and new wrapper targets
- validation commands and results
- remaining user-owned secret/auth steps

---
name: aur-supply-chain-compromise-audit
description: "Audit Arch/CachyOS/AUR systems for known AUR supply-chain compromise exposure using secret-safe, mostly read-only checks: verify current advisories and IOCs, compare installed foreign packages and pacman logs, inspect AUR helper caches/build metadata, scan npm/bun caches, systemd persistence and eBPF/rootkit indicators, and decide when to preserve, reinstall, or rotate credentials."
---

# AUR Supply-Chain Compromise Audit

Use this skill when Clemente asks whether an Arch/CachyOS machine may have been exposed to an AUR compromise, malicious PKGBUILD, AUR helper cache artifact, npm/bun payload, or similar package-supply-chain incident.

## Setup

- Target host should be Arch-like and have `pacman`; common helpers are `yay` and `paru`.
- Start with read-only checks. Do not install or execute third-party scanners from GitHub/gists unless Clemente explicitly authorizes that code path.
- Use ExaSearch for current advisories and IOCs before naming packages, payloads, hashes, maintainer accounts, or compromise windows.
- Do not read secrets. Package logs and build metadata are fine; credential files, browser profiles, wallets, SSH keys, and token stores are not.
- Privileged checks such as `/root` caches, kernel module details, or full filesystem forensics require explicit authorization and should use `sudo-command-execution`.

## Workflow

### 1. Establish the incident scope

Research current authoritative sources first:

```text
ExaSearch queries:
- AUR supply chain attack malicious PKGBUILD indicators compromise
- <incident name> AUR package list payload names hashes
- <payload name> IOC npm preinstall bun systemd eBPF
```

Extract, with citations in your notes:

- compromise window and affected package list
- payload package names, for example `atomic-lockfile`, `lockfile-js`, `js-digest`
- build-system triggers, for example `npm install`, `bun install`, lifecycle `preinstall`
- persistence indicators, systemd unit names/paths, eBPF/BPF filesystem indicators
- response guidance: preserve evidence, rotate credentials, rebuild/reinstall when rootkit indicators appear

### 2. Identify local package exposure

Run read-only host/package inventory:

```bash
printf '== host/time ==\n'
hostnamectl 2>/dev/null | sed -n '1,12p' || true
date -Is

printf '\n== os-release ==\n'
grep -E '^(NAME|PRETTY_NAME|ID|ID_LIKE)=' /etc/os-release 2>/dev/null || true

printf '\n== aur helpers ==\n'
command -v yay paru pikaur trizen aura pacaur 2>/dev/null || true

printf '\n== foreign packages ==\n'
pacman -Qm 2>/dev/null || true
```

Compare `pacman -Qm` with the known affected package list. A package-name match is only an exposure lead, not proof of compromise.

### 3. Check timing in pacman logs

Look for AUR helper upgrades and package operations during the incident window:

```bash
# Replace dates with the incident window.
grep -E '2026-06-(09|10|11|12|13)' /var/log/pacman.log 2>/dev/null || true

grep -Ei 'pacman --upgrade|yay|paru|transaction|installed|upgraded|removed|atomic-lockfile|lockfile-js|js-digest|npm|bun' \
  /var/log/pacman.log 2>/dev/null | tail -n 200 || true
```

Useful interpretations:

- No package operations in the compromise window lowers risk substantially.
- Affected package installed long before the malicious commit is usually not exposed unless reinstalled/upgraded during the window.
- AUR helper cache paths in pacman logs identify which cache to inspect next.

### 4. Inspect AUR helper caches and build metadata

Search build directories and cached package metadata for payload strings. Prefer targeted greps over broad filesystem scans:

```bash
for d in "$HOME/.cache/yay" "$HOME/.cache/paru/clone" "$HOME/.cache/paru"; do
  [ -d "$d" ] || continue
  echo "== cache: $d =="
  grep -RInE 'atomic-lockfile|lockfile-js|js-digest|npm[[:space:]]+(install|ci|i)|bun[[:space:]]+(install|add)|preinstall|src/hooks/deps' \
    "$d" 2>/dev/null | head -200 || true
  find "$d" -type f \( -name PKGBUILD -o -name '*.install' -o -name '*.hook' -o -name '.SRCINFO' \) \
    -newermt '2026-06-09' ! -newermt '2026-06-14' -print 2>/dev/null | head -200 || true
done
```

For a package-name match, inspect its installed metadata without modifying it:

```bash
pkg=python-pylsp-rope
pacman -Qi "$pkg" 2>/dev/null || true
pacman -Qkk "$pkg" 2>/dev/null || true
pacman -Ql "$pkg" 2>/dev/null | sed -n '1,80p' || true
```

### 5. Scan user package-manager caches for payload names

Do not read credential files. It is safe to search cache filenames and package metadata for public payload names:

```bash
for d in "$HOME/.npm" "$HOME/.cache/npm" "$HOME/.bun" "$HOME/.cache/bun"; do
  [ -d "$d" ] || continue
  echo "== cache scan: $d =="
  find "$d" -iname '*atomic-lockfile*' -o -iname '*lockfile-js*' -o -iname '*js-digest*' 2>/dev/null | head -100
  grep -RIlE 'atomic-lockfile|lockfile-js|js-digest|src/hooks/deps' "$d" 2>/dev/null | head -100 || true
done
```

If these searches hit installed payload content, stop broad exploration and move to incident-response mode.

### 6. Check persistence and rootkit indicators

Read-only non-privileged checks:

```bash
printf '== systemd units containing payload names ==\n'
grep -RIlE 'atomic-lockfile|lockfile-js|js-digest|src/hooks/deps' \
  "$HOME/.config/systemd" /etc/systemd/system /usr/lib/systemd/system 2>/dev/null | head -100 || true

printf '== suspicious BPF paths ==\n'
find /sys/fs/bpf -maxdepth 4 -type f -o -type l 2>/dev/null | grep -Ei 'hidden|scale|atomic|digest|lockfile' || true
```

If eBPF/rootkit indicators appear, do not trust the running system. Recommend preservation, offline analysis, credential rotation from a clean device, and reinstall/rebuild.

### 7. Decide and report

Classify findings:

- **No evidence of exposure:** no affected package operations in window, no payload strings in logs/caches, no persistence/rootkit indicators.
- **Possible exposure:** affected package installed/upgraded in window but no payload artifacts found. Recommend deeper cache/log checks and optional `/root` pass.
- **Confirmed compromise indicators:** payload names/files, lifecycle hooks, suspicious systemd/BPF artifacts, or matching hashes. Stop normal use; preserve evidence; rotate credentials from a clean machine; consider reinstall.

Example concise report:

```text
Result: no evidence this machine executed the known AUR malware.
Evidence:
- Host The-Sceptre/CachyOS.
- One affected-list package matched, but installed before the incident window.
- No pacman operations during Jun 9-13.
- No payload-name hits in pacman logs, yay/paru caches, npm/bun caches, systemd units, or /sys/fs/bpf.
Caveat: no privileged /root cache scan performed.
```

## Safety notes

- Do not run unreviewed online scanners as root.
- If using community scripts, fetch and inspect first; prefer reimplementing simple IOC searches locally.
- Avoid reading or printing secrets while looking for credential-stealer evidence.
- For destructive remediation, use planning-first incident response and get Clemente's explicit confirmation.

## Related skills

- `sudo-command-execution` for authorized privileged read-only passes or remediation.
- `linux-live-usb-chroot-recovery` if rebuilding or offline mounting is required.
- `persistent-ssh-agent-fish-systemd` for later credential/SSH-agent hygiene after a clean rebuild.

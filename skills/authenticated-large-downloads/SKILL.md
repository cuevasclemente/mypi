---
name: authenticated-large-downloads
description: Download large authenticated export/archive files such as Google Takeout safely and repeatably using opaque cookies, resumable curl, partial files, validation probes, background logs, and bounded parallelism without exposing credential contents.
---

# Authenticated Large Downloads

Use this skill when a user needs to download a large authenticated archive/export from a browser-only link (Google Takeout, cloud exports, vendor portals, etc.) to a server or headless environment.

## Setup

- Tools: `curl`, `file`, `stat`, `df`, `python3`, and optionally `unzip`, `zipinfo`, `aria2c`, `docker`, `nohup`/`systemd-run`.
- A destination directory with enough free space for the full archive plus partial files.
- An authenticated cookie file only when needed (usually Netscape `cookies.txt`). Treat cookies as secrets:
  - Do **not** `cat`, `head`, `tail`, `grep`, or print cookie contents.
  - Use metadata only: `ls -lh cookies.txt`, `stat cookies.txt`, `file cookies.txt`.
  - Pass it opaquely to tools: `curl -b cookies.txt ...`.
- A known download URL. Always quote URLs because `&` in query strings otherwise backgrounds shell fragments.

## Workflow

### 1. Inspect the situation without exposing secrets

```bash
pwd
df -h .
find . -maxdepth 1 -type f -printf '%f\t%s bytes\t%TY-%Tm-%Td %TH:%TM\n' | sort
```

Look for common failure artifacts:
- zero-byte files from an unquoted URL split at `&`
- `.zip` files that are actually HTML login pages
- existing `.part` files that can be resumed
- `cookies.txt` or `cookies.json` files; verify metadata only

```bash
file -- *.zip *.part cookies.txt 2>/dev/null || true
```

### 2. Diagnose authentication and content type

A browser download URL may not be self-contained. Probe a tiny byte range with cookies, a browser-like user agent, and redacted output:

```bash
url='https://example.invalid/download/export.zip?opaque=query'
tmp=$(mktemp)
code=$(curl -L -sS --max-time 60 --range 0-15 \
  -A 'Mozilla/5.0 (X11; Linux x86_64) Firefox/147.0' \
  -b cookies.txt \
  -o "$tmp" \
  -w '%{http_code} %{content_type} %{size_download}' \
  "$url" 2>/tmp/download-probe.err || true)
python3 - "$tmp" "$code" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
b = p.read_bytes() if p.exists() else b''
print('curl:', sys.argv[2].split()[0:3])
print('downloaded_bytes:', len(b))
print('magic:', b[:8].hex(), 'zip?', b.startswith(b'PK'))
PY
safe-delete "$tmp" >/dev/null 2>&1 || trash-put "$tmp" >/dev/null 2>&1 || gio trash "$tmp" >/dev/null 2>&1 || mv "$tmp" /tmp/download-probe.bin
```

Interpretation:
- `PK...` magic and `application/octet-stream`/`application/zip` means the cookie-authenticated download works.
- HTML (`<!doctype html>`, `text/html`) usually means login/consent/expired cookies.
- `206` with `Content-Range` confirms range/resume support.

To learn total size without downloading the file:

```bash
h=$(mktemp); body=$(mktemp)
curl -L -sS --max-time 60 --range 0-0 -b cookies.txt -D "$h" -o "$body" "$url" >/dev/null || true
python3 - "$h" <<'PY'
import sys
for line in open(sys.argv[1], errors='replace'):
    if line.lower().startswith(('http/','content-type:','content-length:','content-range:','accept-ranges:')):
        print(line.rstrip())
PY
safe-delete "$h" "$body" >/dev/null 2>&1 || true
```

### 3. Prefer resumable partial files

Write to a `.part` file and only rename after validation. Do not overwrite a real completed archive. If an existing final file is HTML, move it aside rather than deleting it.

```bash
cat > resume-download.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail

url='https://example.invalid/download/export.zip?opaque=query'
cookies='cookies.txt'
final='export.zip'
part='export.zip.part'
ua='Mozilla/5.0 (X11; Linux x86_64) Firefox/147.0'

if [[ ! -s "$cookies" ]]; then
  echo "Missing non-empty $cookies" >&2
  exit 2
fi

echo "[$(date -Is)] Starting/resuming download"
echo "[$(date -Is)] Current partial size: $(stat -c '%s' "$part" 2>/dev/null || echo 0) bytes"

curl -L --fail --retry 30 --retry-all-errors --retry-delay 10 \
  --connect-timeout 60 --speed-limit 1024 --speed-time 900 \
  --continue-at - \
  -A "$ua" \
  -b "$cookies" \
  -o "$part" \
  "$url"

echo "[$(date -Is)] curl completed; validating magic bytes"
python3 - "$part" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
b = p.read_bytes()[:4]
if not b.startswith(b'PK'):
    raise SystemExit(f'{p} does not start with ZIP magic bytes; got {b.hex()}')
print(f'{p} starts with ZIP magic bytes')
PY

if [[ -e "$final" ]]; then
  if file --mime-type --brief -- "$final" | grep -qx 'application/zip'; then
    echo "[$(date -Is)] Final zip already exists; leaving partial at $part" >&2
    exit 3
  else
    backup="$final.login-html.$(date +%Y%m%d-%H%M%S)"
    echo "[$(date -Is)] Moving non-zip existing $final to $backup"
    mv -- "$final" "$backup"
  fi
fi

mv -- "$part" "$final"
echo "[$(date -Is)] Done: $final"
ls -lh -- "$final"
SH
chmod +x resume-download.sh
```

Run in the background with durable logs:

```bash
nohup ./resume-download.sh > download.log 2>&1 & echo $! > download.pid
sleep 2
sed -n '1,20p' download.log
```

Monitor:

```bash
tail -f download.log
ps -p "$(cat download.pid)" -o pid,etime,cmd
```

### 4. Download multi-part exports with bounded parallelism

If an export has numbered parts, generate one URL/output pair per part and run only a small number concurrently (for example 2–4). Too much parallelism can exhaust disk IO, trigger provider throttling, or expire cookies sooner.

Pattern:

```bash
cat > download-many.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
concurrency=${CONCURRENCY:-3}
cookies='cookies.txt'
ua='Mozilla/5.0 (X11; Linux x86_64) Firefox/147.0'

# Fill with sanitized part numbers and URLs; keep the real file local, not in chat.
cat > parts.tsv <<'EOF'
001	https://example.invalid/download/export-001.zip?opaque=query
002	https://example.invalid/download/export-002.zip?opaque=query
003	https://example.invalid/download/export-003.zip?opaque=query
EOF

mkdir -p logs
run_one() {
  part_no="$1"; url="$2"
  final="export-${part_no}.zip"
  part="${final}.part"
  log="logs/${final}.log"
  echo "[$(date -Is)] start $final" >> "$log"
  curl -L --fail --retry 30 --retry-all-errors --retry-delay 10 \
    --continue-at - -A "$ua" -b "$cookies" -o "$part" "$url" >> "$log" 2>&1
  python3 - "$part" <<'PY' >> "$log"
import pathlib, sys
p=pathlib.Path(sys.argv[1]); b=p.read_bytes()[:4]
if not b.startswith(b'PK'):
    raise SystemExit(f'bad magic {b.hex()} for {p}')
print('zip magic ok')
PY
  mv -- "$part" "$final"
  echo "[$(date -Is)] done $final" >> "$log"
}
export -f run_one
export cookies ua
xargs -P "$concurrency" -n 2 bash -c 'run_one "$@"' _ < parts.tsv
SH
chmod +x download-many.sh
CONCURRENCY=3 nohup ./download-many.sh > download-many.log 2>&1 & echo $! > download-many.pid
```

For more robust queueing, use `aria2c` if installed, but keep cookies in a local header/cookie file and avoid printing them.

### 5. Browser fallback for headless servers

If cookie export is unavailable or login blocks automation:

- Use a remote browser with persistent profile and noVNC, e.g. a Docker browser image, mapping the destination as the download directory.
- Or launch Firefox/Chromium with a persistent profile and remote debugging/SSH tunnel.
- Avoid pasting “Copy as cURL” commands into chat; they usually contain cookies and authorization headers.

Example Docker/noVNC shape:

```bash
docker run --rm -p 5800:5800 -v "$PWD:/config/downloads" jlesage/firefox
# Open via SSH tunnel: ssh -L 5800:127.0.0.1:5800 <server>
```

## Validation

After completion:

```bash
file -- *.zip
ls -lh -- *.zip
python3 - <<'PY'
import pathlib
for p in pathlib.Path('.').glob('*.zip'):
    print(p.name, p.stat().st_size)
PY
```

For zip archives, run a structural test if affordable:

```bash
unzip -t export.zip >/tmp/export-unzip-test.log && echo 'zip test ok' || tail -40 /tmp/export-unzip-test.log
```

For multipart archives, verify all expected numbers exist and have nonzero sizes. Compare total sizes against `Content-Range`/provider manifest when available.

## Safety notes

- Never read or print cookie/credential contents.
- Keep URLs and cookies out of logs when they contain bearer-like tokens; prefer local scripts over chat transcripts.
- Use recoverable deletion (`safe-delete`, `trash-put`, `gio trash`) for temporary probes.
- Prefer `.part` files and atomic `mv` to final names after validation.
- Leave enough disk headroom for partials, retries, extraction, and provider-generated duplicate files.

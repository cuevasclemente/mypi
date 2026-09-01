---
name: steam-playtime-library-analysis
description: Analyze Clemente's Steam playtime/library data and gaming preferences with secret-safe Steam Web API use, local exports, cross-platform caveats, verified game facts, and recommendation/backlog prioritization without exposing API keys or assuming Steam equals all played history.
---

# Steam Playtime Library Analysis

Use this skill when Clemente asks how to see Steam playtime/statistics, wants a Steam library export, or asks for game/backlog recommendations based on playtime and ownership.

## Setup

- Public profile/library data can be checked without credentials when profile privacy permits.
- Steam Web API exports require a Steam Web API key. Never read, print, paste, or store the key in chat or skill files.
- Accept the key via an environment variable or an opaque file path that a script opens at runtime.
- Treat Steam as a partial signal: Clemente may own or have played games on Switch, PlayStation, Xbox, GOG, itch.io, Epic, emulation, or another account.
- When naming specific games/products, verify current facts from Steam/store/official pages or ExaSearch before making claims.

## Workflow

### 1. Explain the data sources

Start with the lowest-friction options:

- **Steam client/profile:** Profile → Games shows per-game and total hours on record when visible.
- **Recently played:** Steam surfaces recent activity and Steam Web API exposes `playtime_2weeks` for recently played games.
- **Steam Replay / Year in Review:** useful for annual summaries, not a complete historical ledger.
- **Steam Web API `IPlayerService/GetOwnedGames`:** best for repeatable export of owned games, app names, `playtime_forever`, and recent playtime.
- **Third-party calculators:** convenient but require public profile/game details; avoid login-based tools unless Clemente explicitly chooses them.

Important limitations:

- Steam playtime includes idle/menu time and can miss offline or non-Steam play.
- Profile privacy can hide game details from API callers.
- Historical per-day/per-month playtime is generally not available retroactively from Steam; start logging snapshots if Clemente wants trends going forward.
- Steam-only recommendations will falsely label cross-platform games as unplayed unless Clemente supplies exclusions.

### 2. Verify API and privacy requirements

Before scripting, verify current Steam API docs/search results for:

- `IPlayerService/GetOwnedGames`
- required parameters: `key`, `steamid`
- useful booleans: `include_appinfo`, `include_played_free_games`
- fields: `appid`, `name`, `playtime_forever`, `playtime_2weeks`

Ask Clemente for either:

- a public Steam profile URL/SteamID64, or
- permission to use a known SteamID64 from local context if already established.

For API keys, use one of these patterns:

```bash
# Environment variable (do not echo it)
export STEAM_API_KEY=...
python scripts/steam_export.py --steamid 7656119...

# Opaque key file path (script reads it; agent never cats it)
python scripts/steam_export.py --steamid 7656119... --key-file /path/to/steam_api_key
```

### 3. Create a secret-safe export script when needed

A minimal script should:

- read the key from `STEAM_API_KEY` or `--key-file`
- never print the key
- call `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/`
- write timestamped JSON and CSV exports
- convert minutes to hours for human analysis
- handle private profile/API errors clearly

Example structure:

```python
#!/usr/bin/env python3
import argparse, csv, json, os, sys, time, urllib.parse, urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--steamid', required=True)
parser.add_argument('--key-file')
parser.add_argument('--out-dir', default='data/steam')
args = parser.parse_args()

key = os.environ.get('STEAM_API_KEY')
if not key and args.key_file:
    key = Path(args.key_file).read_text().strip()
if not key:
    sys.exit('Provide STEAM_API_KEY or --key-file; do not paste the key into chat.')

params = {
    'key': key,
    'steamid': args.steamid,
    'include_appinfo': 'true',
    'include_played_free_games': 'true',
    'format': 'json',
}
url = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?' + urllib.parse.urlencode(params)
with urllib.request.urlopen(url, timeout=30) as r:
    data = json.load(r)

ts = time.strftime('%Y%m%d-%H%M%S')
out = Path(args.out_dir)
out.mkdir(parents=True, exist_ok=True)
json_path = out / f'steam-owned-games-{ts}.json'
csv_path = out / f'steam-owned-games-{ts}.csv'
json_path.write_text(json.dumps(data, indent=2, sort_keys=True))

games = data.get('response', {}).get('games', [])
games.sort(key=lambda g: g.get('playtime_forever', 0), reverse=True)
with csv_path.open('w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['appid', 'name', 'hours_total', 'hours_2weeks'])
    w.writeheader()
    for g in games:
        w.writerow({
            'appid': g.get('appid'),
            'name': g.get('name', ''),
            'hours_total': round(g.get('playtime_forever', 0) / 60, 2),
            'hours_2weeks': round(g.get('playtime_2weeks', 0) / 60, 2),
        })
print(f'wrote {len(games)} games')
print(json_path)
print(csv_path)
```

### 4. Analyze the export

Summarize first, then interpret:

```bash
python - <<'PY'
import csv, sys
p = sys.argv[1]
rows = list(csv.DictReader(open(p)))
rows.sort(key=lambda r: float(r['hours_total']), reverse=True)
print('Top lifetime:')
for r in rows[:20]:
    print(r['name'], r['hours_total'])
print('\nRecently played:')
for r in sorted(rows, key=lambda r: float(r['hours_2weeks']), reverse=True)[:20]:
    if float(r['hours_2weeks']) > 0:
        print(r['name'], r['hours_2weeks'], '2w / total', r['hours_total'])
PY data/steam/steam-owned-games-YYYYMMDD-HHMMSS.csv
```

Look for:

- high-hour clusters: competitive, action mastery, JRPG/VN, puzzle/indie, systems/strategy
- owned-but-nearly-unplayed games that match high-hour clusters
- recent activity versus old favorites
- categories with uncertain signal, e.g. a low-hour sandbox game may mean "not tried" or "bounced"

### 5. Add cross-platform caveats before recommending

Always include a caveat like:

```text
Steam is only a partial played-history signal. If you played Persona 5, Hollow Knight, Phoenix Wright, or BG3 elsewhere, I should exclude them from the “unplayed gap” list.
```

If Clemente corrects the list, revise recommendations rather than defending the Steam-only inference. Offer to maintain a cross-platform exclusions list in a project-local note or Memoriki if he wants durable preference tracking.

### 6. Verify named recommendations

Before describing specific games, search or fetch official pages for current availability and core facts. Avoid invented specs, prices, discounts, release states, or edition details.

A good recommendation report has:

- **Taste clusters:** concise bullets with evidence from playtime.
- **Owned backlog:** high-confidence games already owned and low-hour.
- **New purchase candidates:** only after owned backlog is considered.
- **Uncertainty notes:** cross-platform ownership/play, idle time, old tastes versus current tastes.
- **Next-play queue:** 5-10 games optimized for signal, not just a long list.

Example:

```text
Your Steam data clusters around high-mastery competitive games, demanding action combat, story-rich JRPG/VN games, and clever indie/puzzle games.
After excluding games played elsewhere, the strongest remaining Steam-owned backlog signals are Return of the Obra Dinn, Outer Wilds, AI: The Somnium Files, Dark Souls III, and Yakuza 0. For one new purchase, verify current store pages first; likely candidates depend on whether you want puzzle/deduction, soulslike combat, or tactics.
```

## Safety and privacy

- Do not inspect browser cookies, Steam client credential stores, or password managers.
- Do not paste or print API keys. Refer to secret file paths only as opaque configuration.
- Avoid login workflows unless Clemente uses `browser_wait_for_user` and explicitly asks for authenticated portal navigation.
- Do not publish detailed gaming profile data externally unless Clemente asks.

## Validation

- Confirm the export counts games and writes JSON/CSV.
- Spot-check top games against the Steam UI or API response.
- Confirm recent list uses `playtime_2weeks` and total list uses `playtime_forever`.
- Re-run after privacy changes or if API returns empty data.

## Related skills

- `privacy-aware-product-research` for verified game/product recommendations.
- `memoriki` for durable preference notes or cross-platform exclusions.
- `secret-safe-oauth-migration` for general opaque-secret handling patterns.

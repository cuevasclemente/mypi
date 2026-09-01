---
name: public-api-trading
description: Interact with Clemente's Public.com brokerage API for portfolio snapshots, quotes, option chains, Greeks, and hardened gateway-based order lifecycle operations. Use for Public.com trading tasks, portfolio-open/midday/close reports, queued-order review, and trading-data troubleshooting.
---

# Public API Trading

This skill documents how to use the local Public.com trading integration in `~/src/memoriki/trading/stocks`.

## Authorization and Scope

Clemente authorizes unrestricted use of public market data and read-only Public.com brokerage data for portfolio work. **Using this skill is not blanket authorization to create new exposure.** The hardened execution authorities are:

1. `RISK_REDUCTION` for a pure sell-to-close reduction that the gateway independently proves reduces quantity, gross exposure, and maximum loss without extending duration or adding a leg;
2. `ANSWERED_DECISION` for an unexpired, versioned exact-order `DECISIONS.md` record whose persisted Wayang questionnaire answer was ingested by state tooling as exact `APPROVE` with `authority_granted: true` and matching order/action bindings; or
3. `AUTONOMOUS_ENTRY` only after canonical cutover and authenticated approval of the exact enabled `AUTONOMY.md` bytes/hash/version.

`PENDING_ORDER` and `EXPLICIT_CURRENT_CONVERSATION` are **queues/intents only**. They currently fail closed for execution because no trusted durable verifier exists for them. A pending file, task text, chat instruction, displayed answer, or caller-built artifact cannot authorize an order. Convert the intent into a versioned exact-order decision, collect the answer with the Wayang questionnaire, and ingest that persisted answer through `portfolio_state.py answer-decision`; only the resulting qualifying `ANSWERED_DECISION` may authorize execution.

**Current rollout status: canonical-enabled under exact policy version 2.** Clemente approved and the atomic state transaction installed exact `AUTONOMY.md` SHA-256 `42cbcf8fe194461f4e6590157f6ed163e371e51b507e5f5df30d2993ab8b3da7` on 2026-07-20. Autonomous new entries are authorized only when the current canonical file still says enabled and every fresh reconciliation, proposal, liquidity, factor, preflight, reservation, gateway, budget, and kill-switch gate passes. Missing, malformed, stale, contradictory, disabled, or unavailable governance state fails closed for new entries.

Within the applicable authority:

- You may fetch accounts, holdings, quotes, history, option chains, option Greeks, preflight calculations, orders, and fills.
- Before placing or replacing an order, identify and record its authority source. If authority is ambiguous, do not submit it; surface the question as a blocking decision.
- A risk-reducing order must only reduce current quantity, gross exposure, and maximum loss without extending duration or introducing a new leg. Rolls, longer-duration replacements, new hedges, and other risk-increasing changes are new exposure.
- Every placement or replacement requires a fresh successful preflight for the exact instrument/legs, side/open-close indicators, quantity, order type, and price. Do not retry a rejected preflight blindly.
- Do **not** read or print secret values. Source env files, but never `cat`/`read` them.
- Keep stable client order IDs, brokerage/request IDs, fills, rejects, deferrals, authority, and rationale in durable state and the report.
- Hard rule for Clemente's current strategy: **no naked short options**. Do not sell uncovered calls or uncovered puts, create an uncovered leg, or leg into a spread. Long single-leg calls/puts and genuinely defined-risk spreads may be used when otherwise authorized. Although covered, stock-secured, or cash-secured short options are not naked in principle, the hardened gateway currently rejects sell-to-open single options; research them only and do not execute them through a different path.
- Directional options preference: when Clemente has a directional thesis, prefer the simplest supported structure over a spread by default—usually a long call/put with max loss limited to the debit paid. Do **not** use spreads as the default merely to satisfy the no-naked-options rule.
- Use spreads intentionally, not automatically: choose debit/credit spreads when the thesis specifically benefits from capped-risk/capped-reward structure, lower debit, defined collateral, volatility/range capture, or another spread-specific reason. Explicitly note that spreads cap gains and may require more active management.

Current known Public API/account constraint: on 2026-05-13, preflight for selling 1x `URA260618C00062000` to open against 103+ URA shares was rejected with `Credit and naked options strategies require margin. Enable margin investing to unlock this strategy.` Independently, the hardened gateway currently rejects sell-to-open single options. Do not retry this covered-call order or bypass the gateway; execution would require a future reviewed gateway/schema capability plus changed brokerage permissions and fresh exact preflight.

## Project Paths

- Trading project: `/home/clemente/src/memoriki/trading/stocks`
- Hardened order gateway: `/home/clemente/src/memoriki/trading/scripts/public_order_gateway.py`
- Gateway command contract: `/home/clemente/src/memoriki/trading/scripts/README.md`
- Existing MCP wrapper: `/home/clemente/src/memoriki/trading/stocks/public_api_mcp/server.py`
- Portfolio task prompts: `/home/clemente/src/memoriki/trading/tasks/`
- Portfolio state contract: `/home/clemente/src/memoriki/trading/portfolio-state/README.md`
- Autonomy/kill-switch artifact: `/home/clemente/src/memoriki/trading/portfolio-state/AUTONOMY.md`
- Current operating ledgers: `/home/clemente/src/memoriki/trading/portfolio-state/{CURRENT,PROPOSALS,DECISIONS,ORDERS}.md`
- Durable policy/history handoff: `/home/clemente/src/memoriki/trading/PORTFOLIO-OPERATIONS-HANDOFF.md`
- Matrix credentials for reports: `/home/clemente/src/memoriki/trading/matrix.env` (source only; Report Publisher normally owns notification)
- Public API env: `/home/clemente/src/memoriki/trading/stocks/env` (source only)
- Account ID: `5OS74818`

## Continuity State and Bounded Autonomy

For every scheduled or ad-hoc Public portfolio workflow, follow `portfolio-state/README.md` as the state contract and its declared rollout phase. Load operational state in this order:

1. `AUTONOMY.md`
2. `CURRENT.md`
3. `PROPOSALS.md`
4. `DECISIONS.md`
5. `ORDERS.md`
6. latest relevant report/artifacts only as needed
7. `PORTFOLIO-OPERATIONS-HANDOFF.md` for durable policy and historical context

Public is always authoritative for live holdings, cash, orders, and fills. Before canonical cutover, the handoff/tasks remain authoritative policy and the ledgers are shadow state. After a valid cutover, the Markdown ledgers govern proposals, decisions, reservations, budgets, and agent authorization. Any brokerage/ledger discrepancy suspends new entries until reconciled.

The approved **future** bounded-autonomy envelope is documented now for shadow validation, not live use:

- eligible instruments: stocks/ETFs, buy-to-open long calls/puts, and atomically submitted genuinely defined-risk spreads;
- maximum autonomous purchase cost or defined maximum loss: exactly **$3,000.00 per thesis**;
- maximum gross autonomous new risk: exactly **$6,000.00 per U.S. trading day**, without recycling capacity after same-day exits;
- at most one new autonomous thesis per workflow run;
- the approximately $6,500 “full-bite” framework is never autonomous and requires a qualifying exact-order `ANSWERED_DECISION`;
- each option proposal must define numeric OI/volume, bid-ask width/slippage, DTE, and maximum premium/loss gates before `ARMED` status;
- preflight, durable risk reservation, stable idempotent order ID, and post-order reconciliation remain mandatory.

These bounds confer **no authority while disabled**. Live bounded autonomy requires all release tests, canonical cutover, `autonomous_entries_enabled: true`, and Clemente's authenticated approval of the exact enabled `AUTONOMY.md` bytes/hash/version. Never infer approval from the plan, a prior discussion, a limit value, or an unanswered decision.

Every run advances existing stable-ID proposals and decisions before creating a new candidate. No proposal or blocking decision may silently disappear. An unanswered decision preserves the current state; expiry triggers re-evaluation, never implicit approval.

## Environment Setup

Use the local virtualenv if present. If dependencies are missing, install the SDK without packaging the project:

```bash
cd /home/clemente/src/memoriki/trading/stocks
uv pip install --python .venv/bin/python publicdotcom-py mcp anthropic python-dotenv prompt-toolkit matrix-nio
```

Run Python snippets with env sourced and project path set:

```bash
cd /home/clemente/src/memoriki/trading/stocks
set -a && . ./env && set +a
PYTHONPATH=. .venv/bin/python your_script.py
```

If `PUBLIC_API_KEY` returns `401 Invalid secret`, stop treating brokerage data as authoritative, note the failure in the report, and ask Clemente to refresh the key. You may still use public market-data fallbacks for analysis.

## MCP Wrapper Tools

The local FastMCP wrapper currently exposes read-only tools:

- `get_accounts()`
- `get_portfolio(account_id="5OS74818")`
- `get_history(account_id, start=None, end=None, page_size=None, next_token=None)`
- `get_quotes(symbols=[...], account_id="5OS74818")`
- `get_instrument(symbol, instrument_type="EQUITY")`

Direct Python example:

```python
from public_api_mcp.server import get_portfolio, get_history, get_quotes

acct = "5OS74818"
print(get_portfolio(acct))
print(get_quotes(["SPY", "URA", "EEM"], acct))
```

The wrapper does **not** currently expose option-chain helpers. Read-only SDK calls are permitted for those. It does not expose order lifecycle operations; use the hardened gateway only.

## Read-only SDK Basics

```python
import os

from public_api_sdk import ApiKeyAuthConfig, PublicApiClient

acct = "5OS74818"
client = PublicApiClient(ApiKeyAuthConfig(api_secret_key=os.environ["PUBLIC_API_KEY"]))
try:
    portfolio = client.get_portfolio(account_id=acct)
    accounts = client.get_accounts()
finally:
    client.close()
```

Serialize Pydantic/Decimal responses before saving:

```python
from decimal import Decimal
from datetime import datetime
import json

def default(o):
    if isinstance(o, Decimal): return float(o)
    if isinstance(o, datetime): return o.isoformat()
    raise TypeError(type(o).__name__)

def dump(obj):
    return json.dumps(obj.model_dump(by_alias=True), default=default, indent=2)
```

## Quotes and Portfolio

```python
from public_api_sdk.models.order import OrderInstrument
from public_api_sdk import InstrumentType

instruments = [OrderInstrument(symbol=s, type=InstrumentType.EQUITY) for s in ["SPY", "URA"]]
quotes = client.get_quotes(instruments=instruments, account_id=acct)
portfolio = client.get_portfolio(account_id=acct)
```

Use `get_history` for filled orders, dividends, fees, and recent activity:

```python
from datetime import datetime, timezone, timedelta
from public_api_sdk import HistoryRequest

end = datetime.now(timezone.utc)
start = end - timedelta(days=7)
history = client.get_history(HistoryRequest(start=start, end=end, page_size=100), account_id=acct)
```

## Options Chains and Greeks

Relevant SDK methods:

- `get_option_expirations(expirations_request, account_id=acct)`
- `get_option_chain(option_chain_request, account_id=acct)`
- `get_option_greek(osi_symbol, account_id=acct)`
- `get_option_greeks([osi_symbol, ...], account_id=acct)`

Example:

```python
from public_api_sdk.models.option import OptionExpirationsRequest, OptionChainRequest
from public_api_sdk.models.order import OrderInstrument
from public_api_sdk import InstrumentType

underlying = OrderInstrument(symbol="SMH", type=InstrumentType.EQUITY)
expirations = client.get_option_expirations(OptionExpirationsRequest(instrument=underlying), account_id=acct)
chain = client.get_option_chain(OptionChainRequest(instrument=underlying, expiration_date="2026-06-26"), account_id=acct)
```

For portfolio reports, compute spread marks from bid/ask midpoint of long leg minus short leg, and use SDK Greeks for exact net delta/theta/vega when available.

## Hardened Order Gateway (Only Supported Lifecycle Path)

After canonical cutover, **never call direct Public SDK placement, cancellation, or replacement methods**. This applies without exception to risk reductions, protective stops, answered decisions, future autonomous entries, cancels, and replacements. Use `trading/scripts/public_order_gateway.py` for preflight, durable `PREPARED` reservation, exact-order verification, submission/cancellation/replacement, and immediate reconciliation. Do not invoke lower-level state helpers as a substitute for broker evidence.

The gateway supports a deliberately narrow set: whole-share equity and long-option open/close orders, exact 1:1 atomic vertical entry/close, `DAY`, and bounded `LIMIT`/supported sell-to-close stop structures. Read `trading/scripts/README.md` before constructing the exact JSON payload. Use stable `O-...`, `P-...`, `T-...`, and UUIDv4 client order IDs; the proposal must contain the exact normalized order digest and positive action version required by the gateway.

### Trusted launcher steps for scheduled and ad-hoc Wayang workflows

The security model is a trusted local Wayang/agent process, not a hostile-process sandbox. For **every** gateway preflight or mutation:

1. Call the no-input `wayang_runtime_context` tool in the current session and use its exact returned `session_id`. Do not infer from cwd/recency/history, generate, shorten, reuse, or guess it. If the tool is unavailable or its returned cwd differs from the trading project, fail closed for mutation.
2. Set `PUBLIC_GATEWAY_SESSION_ID` to exactly that returned `session_id`, and put the same exact value in payload `workflow_session`. For scheduled sessions, retain the returned scheduled job/run IDs in the audit record. Mutating commands fail closed if the session binding is absent or differs.
3. Leave `PUBLIC_GATEWAY_AUTHENTICATED_ACTOR` unset for `RISK_REDUCTION` and future `AUTONOMOUS_ENTRY`.
4. Only for `ANSWERED_DECISION`, read `authenticated_actor` from the verified, state-ingested decision record and have the trusted launcher set `PUBLIC_GATEWAY_AUTHENTICATED_ACTOR` to that exact value. It must also match the exact authority artifact. Never invent an actor, accept caller-provided actor prose, or derive one from chat text.
5. Source the Public env opaquely in the launcher (never print it), then run the gateway from the repository root. The gateway itself never reads env files.

Use preflight-only mode first; it contacts Public but does not reserve or submit:

```bash
cd /home/clemente/src/memoriki
trading/stocks/.venv/bin/python trading/scripts/public_order_gateway.py \
  dry-run --input /path/to/exact-order.json
```

Only after authority, bindings, fresh Public reconciliation, and the dry run pass may the trusted workflow use the literal lifecycle command:

```bash
trading/stocks/.venv/bin/python trading/scripts/public_order_gateway.py \
  submit --input /path/to/exact-order.json
# For canonical recorded orders, use `cancel` or the atomic safe `replace` command.
```

The payload and environment must already contain the trusted context described above. A default/preflight or `dry-run` result is not authority. A placement exception becomes `UNKNOWN`; retain the reservation and reconcile by stable IDs rather than retrying blindly.

### Exact-order answered-decision conversion

To make a queued or conversational intent executable after cutover:

1. Reconcile Public and canonical state, then fully normalize the exact order through the gateway's preflight-only path.
2. Create/update the proposal with immutable thesis ID, exact instrument/leg/side/quantity/risk fields, `authorized_order_digest`, and positive `authorized_action_version`.
3. Create a versioned `D-...` exact-order decision binding that one digest/action version and the relevant proposal/state versions. Its `exact_question` must literally show `authorized_order_digest=<digest>` and `authorized_action_version=<version>`. Surface it in its own Wayang questionnaire request: question `id` and `label` both equal the D-ID, `prompt` exactly equals `exact_question`, and predefined option values exactly match ledger `options` in order after omitting `FREE_TEXT`, with every visible option label exactly equal to its value; never group decisions.
4. After Wayang durably persists the answer, ingest it with `portfolio_state.py answer-decision` using the persisted request ID and expected boundaries. Never pass raw answer or actor text; the unsafe test-only path cannot grant authority.
5. Proceed only if the resulting decision is unexpired `ANSWERED`, exact `APPROVE`, `authority_granted: true`, and its authorized/approved digest and action version match the current order. Build the strict version-1 authority artifact only from that verified record, and use `ANSWERED_DECISION` through the gateway.

`REJECT`, `YES`, free text (even text saying `APPROVE`), unanswered/expired/stale answers, a displayed questionnaire result, and `authority_granted: false` all fail closed.

## Pending Orders / Current-Conversation Intents

For portfolio workflows:

1. Check `/home/clemente/src/memoriki/trading/pending-orders.md` and current-session requests, but inventory them only as queued intents.
2. Do not use `PENDING_ORDER` or `EXPLICIT_CURRENT_CONVERSATION` as execution authority; both currently fail closed.
3. Convert each still-valid exact intent through the versioned `DECISIONS.md` and persisted Wayang questionnaire process above. Until that succeeds, report it as blocked/awaiting decision, not authorized or `PREPARED`.
4. Reconcile the intent against proposals, decisions, orders, brokerage truth, and reservations so it cannot duplicate a working/partial/unknown order.
5. Preserve the queue until every instruction is durably represented by a decision/order lifecycle or an explicit durable successor. Use recoverable deletion only under the task's retention rules.
6. Record approvals, rejects, deferrals, fills, stable client/brokerage IDs, authority, and rationale in canonical state, the management brief, and the daily report.

## Session-Primary Output and Reporting Requirements

The originating Wayang session is the primary management interface. Finish every scheduled or ad-hoc Public workflow with a concise management brief containing:

- status: NAV/exposure/P&L and the highest current risk;
- meaningful changes since the prior check;
- actions taken, with authority type, preflight/result, and order status;
- existing stable-ID plan/proposal status before new ideas;
- **all** currently blocking decision IDs and the recommendation, or an explicit statement that none block action;
- autonomous-entry status and budget used/remaining — while disabled, state that it is disabled and that no autonomous entry occurred;
- what the next workflow must check first; and
- local report path, Report Publisher URL, and notification/TTS status.

No material proposal, action, or blocking decision may exist only in the full report. Distinguish `FOR AWARENESS`, `DECISION REQUIRED`, `AUTHORIZED/ARMED`, and `ACTION TAKEN`. If clickable questions are supported and validated, market work, state persistence, report publication, and the textual brief must complete before opening them; unanswered questions must not imply authorization.

For every **newly created or materially revised, fully specified actionable** blocking `D-...` from this run that lacks an unchanged pending/submitted question, invoke a **separate** Wayang questionnaire tool request containing exactly one question for exactly that decision. Scheduled runs do this only after all substantive work and the textual brief are complete; never duplicate a question, wait for an answer, or make run completion depend on it. Disabled autonomy does not disable human decision questionnaires. Question `id` and `label` must both equal the D-ID, `prompt` must exactly equal ledger `exact_question`, and predefined option values must exactly match ledger `options` in order after omitting `FREE_TEXT`, with every visible option label exactly equal to its value. Never group decisions. Exact-policy prompts must literally display the target hash, policy version, and cutover ID; exact-order prompts must literally display the digest and action version. Each persisted request can then be ingested independently; custom/free-text `APPROVE` never grants authority.

For every trading-data run, include:

- Whether Public API access succeeded or failed.
- Portfolio value, cash/buying power, daily change, unrealized P&L, realized P&L, fees, and total P&L when available.
- All orders placed/cancelled/replaced and their IDs/statuses.
- Option spread P&L vs premium paid, DTE, and closest management trigger (50% profit or 21 DTE).
- Factor mix and allocation drift by cost basis.
- Data caveats if any field used public-market fallback instead of brokerage truth.

For portfolio-open, midday, close, weekly, and other scheduled Public tasks, use the Report Publisher MCP rather than sending Matrix/Element messages directly. Element is a concise mirror of the session-primary brief, not the canonical decision surface:

- Write the markdown report under `/home/clemente/src/memoriki/trading/reports/` first.
- Call `publish_report` with `notify=true` and usually `tts=true` when requested by the task prompt.
- Use an appropriate `producer`, such as `wayang:portfolio-open`, `wayang:portfolio-midday`, or `wayang:portfolio-close`.
- Include NAV/change, highest risk, actions, important existing-plan changes, blocking decision count/IDs with direction to respond in Wayang, disabled/enabled autonomy status and budget, and the full report link.
- Do not read Matrix credential files and do not send Matrix messages directly when the task prompt specifies Report Publisher.
- If Report Publisher writes the OpenCloud package but fails or times out during link generation/TTS, record the partial success, local report path, remote package path if available, and failure mode in the session summary.

Direct Matrix sending is a legacy fallback only when Clemente explicitly asks for it and authorizes bypassing Report Publisher. Even then, source secret env files without printing their contents.

---
name: kalshi-event-trading
description: >-
  Monitor and wind down Clemente's Kalshi prediction-market portfolio as a scheduled Wayang task: audit balance/positions/P&L/fees, review existing bets, log calibration updates, cancel exposure-increasing resting orders, optionally close/reduce existing positions for risk-reduction, publish reports, and avoid opening any new Kalshi bets.
---

# Kalshi Portfolio Wind-Down

Monitor Clemente's legacy Kalshi prediction-market portfolio during the project wind-down. The earlier experiment produced useful predictions and findings, but continued diversified Kalshi trading is no longer considered worthwhile because fees/friction are too high. Scheduled runs should continue for monitoring and wrap-up, but the portfolio is no longer in growth/deployment mode.

**Prime directive:** do not open new Kalshi bets. Get out of Kalshi as soon as practical: exit existing positions whenever they can be closed at net break-even or any net profit after spread/fees, otherwise let positions resolve over time. Use reports to track cash/P&L/fees/calibration and prepare for eventual withdrawal of freed cash from Kalshi only when Clemente authorizes it.

**Scope:** this skill targets prediction-market wind-down on Kalshi only. Do not involve unrelated brokerage, cash-deployment, or transfer workflows.

## Setup

The Kalshi MCP/client code lives at `/home/clemente/src/memoriki/trading/kalshi/`. Import only what is needed for monitoring/wind-down:

```python
import sys
sys.path.insert(0, "/home/clemente/src/memoriki/trading/kalshi")
from kalshi_mcp.config import Config
from kalshi_mcp.kalshi_client import KalshiClientWrapper
from kalshi_mcp.prediction_log import PredictionLog
from kalshi_mcp.risk import compute_edge
```

Credential files are stored at:
- Access key ID: `~/src/memoriki/secure_data/kalshi-access`
- Private key: `~/src/memoriki/secure_data/kalshi-secret`

**Never read credential file contents directly.** Use environment variables supplied by the scheduler/session. It is okay to reference secret paths, but do not print or inspect secret values.

Predictions database: `~/src/memoriki/trading/kalshi/predictions.db`

Session logs/reports: `/home/clemente/src/memoriki/trading/reports/` and Report Publisher MCP.

## Required Runtime Environment

```bash
# Provided by scheduler/session; do not print the value.
KALSHI_API_KEY_ID=<provided by environment>
KALSHI_PRIVATE_KEY_PATH="/home/clemente/src/memoriki/secure_data/kalshi-secret"
KALSHI_ENV="production"
PREDICTION_LOG_PATH="/home/clemente/src/memoriki/trading/kalshi/predictions.db"
```

## Wind-Down Rules

- **No new positions:** do not enter new markets, add to existing positions, or place orders that increase gross or net exposure.
- **No utilization target:** idle cash is fine. Ignore previous 80%+ deployment goals and underdeployment logic.
- **Allowed actions only:**
  - Hold existing bets until resolution only when no clean wind-down exit is available.
  - Cancel stale/open resting orders that would add/increase exposure.
  - Close or partially close an existing position when it can be exited at net break-even or any net profit after spread/fees.
  - Close or partially close an existing position when it clearly reduces risk, expected loss, concentration, or exit complexity.
  - Use cash only to reduce/exit existing exposure, not to pursue new edge.
- Treat break-even/profitable closes as wind-down exits, not as optional profit-maximizing trades. If an order is ambiguous or could accidentally increase exposure, do not place it. Explain the ambiguity in the report and wait for Clemente.
- Do not scan broad Kalshi categories for new opportunities; review existing open positions and thesis groups only.

## Workflow

### Step 1: Portfolio Review

1. **Balance and positions**
   - `client.get_balance()` → current cash balance and portfolio value
   - `client.get_positions()` → all open and closed positions
   - `client.get_trades(limit=50)` → recent trade history
   - If available, inspect open/resting orders and cancel exposure-increasing orders.

2. **Prediction log and calibration**
   - `pred_log.get_predictions(limit=20)` → recent logged predictions
   - `pred_log.get_calibration_summary()` → Brier score, accuracy, coverage

3. **Wind-down state**
   - Cash balance available now
   - Mark value still tied up in open positions
   - Position count and expected resolution timing
   - Resolved cash that may later be withdrawn from Kalshi after explicit authorization

4. **Concentration by thesis group**
   - Group correlated positions (e.g., multiple thresholds on the same event, multiple deadlines on the same outcome)
   - Calculate % of portfolio for each thesis group
   - Flag any group exceeding ~30%, but do not add hedges/new markets solely to fix concentration

5. **Top-level P/L** (always include in summary)
   - Treat cash balance and position mark as separate components, then reconcile `total value = cash + position mark`.
   - Verify the current client/API semantics before calculating: recent V2 responses have exposed `portfolio_value` as position value only, while older wrapper/report code sometimes treated it as total account value and subtracted cash. Do not blindly subtract cash.
   - Cost basis = sum of `market_exposure_dollars` for positions with `position_fp != 0`
   - Unrealized P/L = position mark value − cost basis (show $ and %)
   - Realized P/L (lifetime) = sum of `realized_pnl_dollars` over ALL positions (include closed)
   - Fees paid (lifetime) = sum of `fees_paid_dollars` over ALL positions
   - Total P/L = unrealized + realized − fees
   - Also show a conservative displayed-bid liquidation value when available; label it separately from API mark value.

### Step 2: Review Existing Bets Only

For each material open position or thesis group:

1. Read market rules carefully — resolution criteria, deadline, settlement source.
2. Research current evidence only as needed to monitor existing exposure.
3. Form/update an independent probability estimate.
4. Compare to current market price to decide: close/partial close if net break-even or profitable after spread/fees; otherwise hold, close, partial close, or wait based on wind-down risk.
5. Note expected resolution timing and likely cash release.

Do **not** cast a wide net for new opportunities. Do **not** identify priority trades for freed cash except wind-down exits from existing positions.

### Step 3: Log Monitoring Predictions

For every existing market assessed, log an updated prediction when practical:

```python
pred_log.log_prediction(
    ticker=ticker,
    claude_probability=prob,
    market_yes_price_cents=market_price,
    rationale=rationale_text,
    action_taken="hold" or "close" or "partial_close" or "pass",
    # ... additional fields
)
```

The rationale should emphasize current probability, resolution timing, wind-down action/inaction, and fee/spread friction.

### Step 4: Optional Wind-Down Orders

Default is **exit if cleanly break-even/profitable; otherwise zero orders**.

Only place/cancel orders that comply with the wind-down rules:

1. Cancel stale/open orders that would add or increase exposure.
2. Close/partially close existing positions whenever they can be exited at net break-even or any net profit after spread/fees.
3. Close/partially close existing positions with another clear risk-reduction or exit-simplification rationale.
4. Use conservative limit prices; avoid wide spreads unless the wind-down rationale is strong, and do not place ambiguous close orders that might increase exposure.
5. Before closing a held NO position, verify the exact V2 side/action mapping with a preflight or a known-small reduce-only order. A confirmed source run reduced held NO positions with `reduce_only=true`, IOC, through the YES-book bid path; do not generalize this mapping to another client/API version without checking.
6. Format cent-tick limit prices exactly as the endpoint expects. If a logically valid order is rejected with an invalid dollar-precision error, retry only after normalizing to exact 2-decimal cent precision; never change the economic price silently.
7. After every close, reconcile the order status, fill quantity, cash, and resulting position. A submitted/accepted response alone is not proof that exposure reached zero.
8. Never add to a position, open a new market, or redeploy resolved cash into unrelated markets.
9. State explicitly whether any orders were placed/cancelled and why.

### Step 5: Summary and Notification

**Session summary includes:**
- Portfolio status: cash, position mark value, total value, open positions, top-level P/L
- Wind-down status: what resolved, what remains, expected cash release timeline
- Concentration breakdown by thesis group
- Existing markets reviewed and predictions logged
- Any positions that were closeable at net break-even/profit, whether exited or why not
- Orders placed/cancelled, if any, with wind-down rationale
- Explicit statement: “No new Kalshi bets opened.”
- Notes for eventual withdrawal of freed cash from Kalshi, without initiating withdrawals unless Clemente authorizes it

**Report publishing:**
Use the Report Publisher MCP `publish_report` tool after writing the markdown report:
- `title`: `Kalshi Wind-Down Session — YYYY-MM-DD HH:MM`
- `report_type`: `prediction-markets/wind-down-session`
- `producer`: `wayang:kalshi-session`
- `notify`: `true`
- `tts`: `true`

Do not send Matrix/Element messages directly and do not read Matrix credential files. If Report Publisher is unavailable, save the markdown fallback to `/home/clemente/src/memoriki/trading/reports/` and state the failure in the scheduled run transcript.

The Element summary should be 10–15 lines and include:
- Portfolio value, cash balance, and % still in open positions
- Top-level P/L: unrealized, total, lifetime fees
- Wind-down actions taken, if any
- “No new Kalshi bets opened.”
- Positions/thesis groups still awaiting resolution and expected timing
- Cash potentially ready for eventual Kalshi withdrawal

## References

- **Task prompt:** `~/src/memoriki/trading/tasks/kalshi-session.md`
- **Kalshi client code:** `~/src/memoriki/trading/kalshi/`
  - `config.py` — Config class
  - `kalshi_client.py` — KalshiClientWrapper
  - `prediction_log.py` — PredictionLog (SQLite)
  - `risk.py` — helper functions; avoid growth/deployment sizing in wind-down mode
- **Predictions database:** `~/src/memoriki/trading/kalshi/predictions.db`
- **Reports:** `~/src/memoriki/trading/reports/`
- **Credentials (path only):**
  - `~/src/memoriki/secure_data/kalshi-access`
  - `~/src/memoriki/secure_data/kalshi-secret`

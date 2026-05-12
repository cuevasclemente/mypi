#!/bin/bash
# Dreamer Cron Wrapper
# Runs the pi dream cycle at 9am PST daily.
# Invoked by cron: 0 9 * * * /home/clemente/.pi/agent/dreamer-cron.sh >> /home/clemente/.pi/logs/dreamer.log 2>&1

set -euo pipefail

export TZ=America/Los_Angeles
export HOME=/home/clemente
LOG_DIR="$HOME/.pi/logs"
mkdir -p "$LOG_DIR"

RUN_TS=$(date -Iseconds)
echo "=== Dream Cycle Start: $RUN_TS ==="

# Run pi in print mode with the dreamer extension
# Using /tmp as cwd so it doesn't pick up project-specific context
cd /tmp && pi --print \
  -e "$HOME/.pi/agent/extensions/dreamer.ts" \
  "dream" 2>&1

EXIT_CODE=$?
echo "=== Dream Cycle End: $(date -Iseconds) (exit: $EXIT_CODE) ==="
echo ""

exit $EXIT_CODE

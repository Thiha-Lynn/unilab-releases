#!/usr/bin/env bash
# Run from any directory. SSH access to the existing collector host is required.
set -euo pipefail
umask 077
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
SNAPSHOT_DIR="$REPO_DIR/output/pilot/$STAMP"
mkdir -p "$SNAPSHOT_DIR"
ssh "${UNILAB_ANALYTICS_HOST:-awam-prod}" 'sudo env UNILAB_USAGE_DIR=/var/lib/unilab-usage python3 /opt/unilab-usage/server.py report' > "$SNAPSHOT_DIR/operator-report.json"
python3 "$REPO_DIR/analytics/dashboard.py" "$SNAPSHOT_DIR/operator-report.json" "$SNAPSHOT_DIR/operator-dashboard.html"
python3 "$REPO_DIR/analytics/dashboard.py" "$SNAPSHOT_DIR/operator-report.json" "$SNAPSHOT_DIR/public-aggregate.html" --public
printf 'Private snapshot saved: %s\nShare only public-aggregate.html or its daily CSV, never operator-report.json.\n' "$SNAPSHOT_DIR"

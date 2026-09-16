#!/usr/bin/env bash
# Canonical AWS release. GitHub Pages is a separately labelled preview.
# Uses existing SSH configuration; no persistent CI credential is needed.
set -euo pipefail
cd "$(dirname "$0")"
HOST="${UNILAB_HOST:-awam-prod}"
URL="${UNILAB_URL:-https://unilab.ztvmm.live}"
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit changes before deploying an identifiable release.' >&2; exit 1; }
REV=$(git rev-parse HEAD)
RELEASE="${REV}-$(date -u +%Y%m%dT%H%M%SZ)"
REMOTE="/var/www/unilab-releases/$RELEASE"
npm ci
npm test
npm run build
ssh "$HOST" "sudo mkdir -p '$REMOTE' && sudo chown \$(id -un): '$REMOTE'"
# No suppressed failures: a failed transfer cannot proceed to promotion.
rsync -az --stats dist/ "$HOST:$REMOTE/"
ssh "$HOST" python3 - "$REMOTE" <<'PY'
import hashlib,json,sys,pathlib
root=pathlib.Path(sys.argv[1]); release=json.loads((root/'release.json').read_text())
for name,wanted in release['files'].items():
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==wanted, name
print('Remote staged files verified')
PY
PREVIOUS=$(ssh "$HOST" 'readlink -f /var/www/unilab-live')
[[ "$PREVIOUS" == /var/www/unilab* ]] || { echo 'Unexpected current release path' >&2; exit 1; }
# Keep old hashed chunks for already-open tabs. Root files always come from the new release.
ssh "$HOST" "cp -an '$PREVIOUS/assets/.' '$REMOTE/assets/'; chmod -R a+rX '$REMOTE'; sudo ln -s '$REMOTE' /var/www/unilab-next; sudo mv -Tf /var/www/unilab-next /var/www/unilab-live"
if ! node scripts/verify-release.mjs "$URL"; then
  echo 'Verification failed; restoring previous release.' >&2
  ssh "$HOST" "sudo ln -s '$PREVIOUS' /var/www/unilab-rollback; sudo mv -Tf /var/www/unilab-rollback /var/www/unilab-live"
  exit 1
fi
printf 'Deployed %s to %s\nPrevious release retained: %s\n' "$REV" "$URL" "$PREVIOUS"

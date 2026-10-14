# Usage measurement and 30-person pilot

Document processing stays entirely on-device. The app is static browser/native software; an optional first-party collector on the existing host stores counters. The entire ecosystem is therefore not serverless. No Google Analytics account or third-party tracker is required.

The public endpoint accepts bounded event names, tool IDs, platform, version, random session IDs and optional pilot tokens/ratings. No document, filename, text, raw error, URL, IP address or user agent is written to the usage database. IPs are used transiently for rate limiting. Ordinary asset access logs are separate hosting logs. Browser DNT/GPC and the in-app opt-out disable ordinary counts. Explicit pilot consent is separate. Offline events are not queued.

## Operate

Install `server.py` and `tools.json` in `/opt/unilab-usage`, the three systemd units in `/etc/systemd/system`, and the exact `/api/usage` nginx proxy location from `app/ops/unilab.nginx.conf`. Preserve the host's existing TLS/listener configuration. The collector binds loopback only; reports have no public HTTP route. Enable `unilab-usage.service` and `unilab-usage-cleanup.timer`. Private state lives in `/var/lib/unilab-usage`.

```sh
sudo env UNILAB_USAGE_DIR=/var/lib/unilab-usage python3 /opt/unilab-usage/server.py invite --count 30
sudo env UNILAB_USAGE_DIR=/var/lib/unilab-usage python3 /opt/unilab-usage/server.py report > usage-report.json
python3 analytics/dashboard.py usage-report.json usage-dashboard.html
sudo env UNILAB_USAGE_DIR=/var/lib/unilab-usage python3 /opt/unilab-usage/server.py erase --code P001
```

Keep invitation links and reports outside Git. Each link is a bearer invitation; issue one per distinct consenting person. Erasure removes that pilot's token/activity/feedback; anonymous aggregate totals cannot be linked back and remain until expiry. Daily maintenance removes records older than 30 days (day-granularity counts can remain until the next daily run). Do not publish participant codes in a public dashboard.

## Evidence collection

1. Recruit 30 distinct people; exclude automated tests. Keep the organiser's identity-to-code checklist separately with permission and a deletion date.
2. Give each person one invitation. Let them consent themselves; public tools remain usable without joining.
3. Ask each person to solve a real task with a non-sensitive sample they choose: reduce an oversized submission, combine notes, make a QR code, convert notes to a book, or clean a recording.
4. Have them open/inspect the saved output and report yes/partly/no plus ease-of-use in **Usage & pilot feedback**. A download click alone is not success.
5. Reconcile active codes and useful outcomes with observed distinct people. Count one person once across platforms. Aim for 30 tested people and at least 15 independently confirmed useful outcomes; report failures honestly and retest fixes.
6. Export a dated report and screenshot. Add actual anonymised observations to the supervisor PDF. Until real participants use it, the correct count is zero.

Metrics: daily sessions are tab/app sessions renewed after 30 minutes idle, not unique humans; file-selection events are local input, not uploads; completed jobs are observed result states; download requests do not prove a saved file; Android saved events confirm native saving completed. Offline activity, opt-out and blocked traffic are missing. Text tools may produce useful results without a file or completed-job event. Pilot feedback covers those tasks.

Anonymous browser counts cannot prove 30 real people. A separate opt-in study plus organiser verification supplies that evidence without account registration.

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


## Daily operations and public evidence

Run `bash analytics/snapshot.sh` to pull a timestamped private report, operator dashboard and daily CSV. It also generates `public-aggregate.html` and `public-aggregate.daily.csv`, which exclude pilot codes and feedback. Inspect the files before sharing. The script does not publish anything or schedule itself. The collector records online events automatically while the server is running; reports are snapshots.

Daily grouping is UTC (07:00 Bangkok boundary). Keep dated aggregate exports for semester evidence before the rolling 30-day collector window expires; restrict and delete private pilot records according to study consent. Public metrics distinguish sessions, file selections, completed jobs and download requests. They do not measure exact people, input/output byte totals, TikTok referrers or campaign attribution. Social video views are not app users. Pair public activity with consented task observations; never infer a completed upload from local file selection.

## Online team dashboard

`https://unilab.ztvmm.live/usage/` is a public aggregate-only dashboard with a daily CSV download. No account is required. `publish_dashboard.py` reads the private report locally and emits only allowlisted daily numeric totals, zero-filling the last 30 UTC dates. It never publishes raw reports, pilot codes, tokens, feedback, session identifiers or per-tool detail. Exact processed-file counts are not collected: selected-file totals and completed jobs are displayed separately.

Install `publish_dashboard.py` and `public-dashboard.html` alongside the collector. Install `unilab-usage-publish.service` and `.timer` into `/etc/systemd/system`. Include `dashboard.nginx.conf` as a snippet **only inside the existing canonical HTTPS server**, preserving its listeners and TLS settings. The output lives separately in `/var/lib/unilab-public-usage`, so app deployments do not remove it. Validate `nginx -t` before reloading. Enable the timer with `systemctl enable --now unilab-usage-publish.timer` and run the service once for the initial snapshot.

The timer regenerates aggregates every five minutes, including quiet days and after reboot; the browser fetches every minute with caching disabled. The page shows the snapshot timestamp and marks data older than 15 minutes as delayed. A failed refresh retains the last displayed values. Check `systemctl status unilab-usage-publish.timer` and `journalctl -u unilab-usage-publish.service` for failures. Only the HTML, aggregate JSON and CSV have public routes; other `/usage/` paths return 404. Dashboard visits generate no application telemetry.

This is a rolling report, not a permanent historical archive. Keep a dated CSV for assessment milestones. Offline and opted-out activity remains absent, and distinct participants still require the consented study.

The app service worker explicitly bypasses `/usage/` and `cache: no-store` requests and does not stash `Cache-Control: no-store` responses. Deploy the app change too: otherwise previously installed offline PWAs can retain old aggregate responses despite HTTP cache headers. Existing clients receive the updated service worker on their next app navigation; reopening the dashboard after visiting the app updates older installations.

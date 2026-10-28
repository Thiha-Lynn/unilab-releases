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

Daily grouping is UTC (07:00 Bangkok boundary). Keep dated aggregate exports for semester evidence before the rolling 30-day collector window expires; restrict and delete private pilot records according to study consent. Public metrics distinguish sessions, file selections, completed jobs and download requests. They do not measure exact people, unique document identities, input/output byte totals, TikTok referrers or campaign attribution. Social video views are not app users. Pair public activity with consented task observations; never infer a completed upload from local file selection.

## Online team dashboard

`https://unilab.ztvmm.live/usage/` is a public aggregate-only dashboard with a daily CSV download. No account is required. `publish_dashboard.py` reads the private report locally and emits only allowlisted daily numeric totals, zero-filling the last 30 UTC dates. It never publishes raw reports, pilot codes, tokens, feedback, session identifiers or per-tool detail. Processed input occurrences are recorded at successful tool completion; selection counts and completed jobs remain separate.

Install `publish_dashboard.py` and `public-dashboard.html` alongside the collector. Install `unilab-usage-publish.service` and `.timer` into `/etc/systemd/system`. Include `dashboard.nginx.conf` as a snippet **only inside the existing canonical HTTPS server**, preserving its listeners and TLS settings. The output lives separately in `/var/lib/unilab-public-usage`, so app deployments do not remove it. Validate `nginx -t` before reloading. Enable the timer with `systemctl enable --now unilab-usage-publish.timer` and run the service once for the initial snapshot.

The timer regenerates aggregates every five minutes, including quiet days and after reboot; the browser fetches every minute with caching disabled. The page shows the snapshot timestamp and marks data older than 15 minutes as delayed. A failed refresh retains the last displayed values. Check `systemctl status unilab-usage-publish.timer` and `journalctl -u unilab-usage-publish.service` for failures. Only the HTML, aggregate JSON and CSV have public routes; other `/usage/` paths return 404. Dashboard visits generate no application telemetry.

This is a rolling report, not a permanent historical archive. Keep a dated CSV for assessment milestones. Offline and opted-out activity remains absent, and distinct participants still require the consented study.

The app service worker explicitly bypasses `/usage/` and `cache: no-store` requests and does not stash `Cache-Control: no-store` responses. Deploy the app change too: otherwise previously installed offline PWAs can retain old aggregate responses despite HTTP cache headers. Existing clients receive the updated service worker on their next app navigation; reopening the dashboard after visiting the app updates older installations.

## Daily visitors and successful input files

Daily visitor IDs are random 128-bit values in first-party local storage, rotated on the UTC date. Web Locks serialize initial creation across tabs when available; storage-blocked clients omit visitor IDs rather than minting one per event. The server stores only a keyed hash scoped to that day, for at most the normal 30-day window. The metric counts browser/app instances, not distinct humans. Clearing storage, private sessions, multiple devices and shared browsers affect it. Never add daily uniques together and label them monthly people. DNT/GPC and explicit opt-out suppress ordinary telemetry and remove the local daily ID. Separate consented pilot activity does not override visitor-ID opt-out.

`files_processed` is emitted explicitly after usable results are produced, not inferred from selection or a download click. Its count is successful primary input-file occurrences: merge 3 inputs -> 3; split a PDF into 100 pages -> 1; repeat processing -> another occurrence; repeated downloads -> 0 additional processing. Partial legacy conversion batches count successful inputs only. Tool-shell exports count their actual input list, with scan-to-PDF reporting its retained page images. Typed text and live recordings without an input file contribute no file count. Auxiliary decoration/signature assets are not primary input files. Each processing receipt has a random event ID and is deduplicated server-side for 30 days. No file name, contents, file hash, size or document identifier is sent. A successful output is not proof the person achieved their goal.

`metricsStartedAt` is stored once at collector migration. Earlier dates show null/unavailable, not reconstructed zeros. The first day is partial; old app versions and blocked/offline use are missing. The dashboard displays today's unique instances and processing totals within the displayed 30-day window, and includes daily visitors/processedFiles in the CSV. QA stays excluded from live counters. Backend must be installed before deploying the updated app, then restart the collector and publish service; the new SQLite tables are additive. Back up the DB with SQLite's backup API first.


## Advisor evidence checklist (28 October 2026)

- Show the live dashboard timestamp and download its daily CSV. These are observed, incomplete telemetry totals, not proof of distinct people.
- Keep a dated aggregate CSV at assessment milestones before the rolling 30-day window expires. No terminal command is needed: use the dashboard download button.
- Maintain the private consent/eligibility register separately. One participant code per distinct person, reused across devices; exclude team members, automated QA and duplicate participants from the real-user study.
- For each of the four field-kit tasks, record the participant code, task, observed completion, elapsed time, assistance, output inspection, usefulness answer and defect/retest outcome. Never attach private source files to public evidence.
- Present the denominator: invited, consented eligible participants, attempted tasks, successful tasks and independently confirmed useful outcomes. Missing responses are missing, not successes. Target 30 participants; ask the advisor to confirm the formal minimum and eligibility rules.
- Pair product verification (CI, synthetic fixture checks and release revision) with user evidence (consented observations and SUS/TAM). Neither replaces the other.
- Public analytics cannot be a fraud-proof census: clients self-report and events may be blocked. Do not manufacture traffic or present QA events as real usage.

The busy tool shell rejects new file drops and repeat starts until a run finishes. Cancelled shell runs emit no successful-file receipt. Video-frame extraction counts its single input when the first downloadable frame appears, because partial outputs remain usable after stopping; further frames and re-downloads do not add processing counts. Consent is checked again after the visitor lock resolves.

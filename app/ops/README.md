# Releases

Canonical production: https://unilab.ztvmm.live (AWS Lightsail, `awam-prod`).
GitHub Pages remains a preview of tested `main`, not the canonical production URL.
The legacy nip.io URL redirects to production. Namecheap has an A record for
`unilab` pointing to 3.0.126.159; other records are unchanged.

## Publish

1. Use a feature branch and pull request. `Tests and production build` must pass.
2. Merge, pull the tested commit, and run `./deploy.sh` from a clean checkout.
3. The script installs locked dependencies, tests, enforces the 8,000,000-byte
   offline budget, builds, stages and checks hashes before switching the live symlink.
4. It verifies every deployed file against `release.json`, MIME types and camera/
   microphone policy. A failed live check restores the prior symlink and exits nonzero.
5. Compare `https://unilab.ztvmm.live/release.json` with the intended commit.

SSH credentials remain in the operator's existing SSH configuration. They are not
committed or copied into GitHub. GitHub Actions publishes the Pages preview only;
production requires the explicit operator command above. Do not call a preview
run a production release.

`/var/www/unilab-live` points at a release under `/var/www/unilab-releases/`.
The first fallback is `/var/www/unilab`. Prior releases and their hashed assets are
retained so open tabs can load old lazy chunks. To roll back, atomically replace
`unilab-live` with a symlink to the previous path printed by deploy.sh. Only prune
old releases during maintenance, after checking the active target.

## Host configuration

`unilab.nginx.conf` and `unilab-headers.conf` are the deployed UniLab configuration.
Test with `sudo nginx -t` before reloading. No other virtual host should be changed.
Fonts are revalidated; hashed assets are immutable. Camera and microphone are
allowed for the same origin; the browser still asks the visitor for permission.
TLS certificate: `/etc/letsencrypt/live/unilab-ztvmm/`, renewed by certbot.timer;
existing renewal hook validates and reloads nginx. Certificate issued 16 Sep 2026,
expires 15 Dec 2026. Old nip.io certificate is retained for redirects.

`provision-awam.sh` is historical bootstrap documentation. Do not rerun it over
this release layout; use the reviewed configuration files in this folder.

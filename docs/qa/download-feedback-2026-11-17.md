# Download feedback correction — 17 November 2026

Trigger: supplied survey concerns and four task-record save reminders highlighted save discoverability. Source inspection also found that the result button did not await ZIP export failures.

Changes: persistent, readable saving instructions beside the result action; asynchronous ZIP failures produce retry guidance; a disabled button prevents duplicate exports while an export is pending. The UI does not claim a browser dispatch proves that a file was saved on disk. No document data is sent by this change.

Matched regression: running the new result-screen regression against baseline `45e98702201dbecce6fc7e01a14cfb2289ec4ac0` fails because the required save guidance is absent; the corrected code passes. The new test also exercises ZIP rejection, retry, duplicate clicks and the absence of a false saved claim. [Before log](evidence/download-feedback-baseline.txt), [after suite](evidence/download-feedback-tests.txt), [build](evidence/download-feedback-build.txt).

Validation:42application tests pass; build passes,98precache files and7.94MBrounded core. This test was AI-assisted. Before/after regression behavior is measured engineering evidence, not a causal estimate of AI productivity. It does not measure a changed SUS score, student success rate or physical-device usability. Those require a new real retest wave. No live deployment is implied by this branch.

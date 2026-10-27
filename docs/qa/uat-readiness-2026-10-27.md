# November field-workflow readiness

Based on Swan Htut's coursework plans (Thiha-Lynn/unilab PRs #20 and #21); owner selected the newer four-task set on 27 October. Companion evidence kit: https://github.com/Thiha-Lynn/unilab/pull/22.

Implemented compression grayscale + page-specific 180-degree correction, decimal target caps, mixed PDF/JPG/PNG assembly, and optional AES-256 protection after signing. Added the 50 MiB input ceiling to compression and merge. Existing page extraction verified against a 120-page synthetic source. All document processing remains on-device. Passwords are not sent to the usage collector.

Verification in the accompanying working tree: 37 app tests, 7 collector/dashboard tests, 2 desktop policy tests; four production-build browser workflows pass. The JSON records the base revision; it is not a claim that the old deployed v0.4.0 contained these changes. The pre-existing local dependency updates were preserved separately and excluded from this PR. CI on the exact PR commit is the reproducibility check.

Offline core remains below 8,000,000 bytes with the compressed QPDF runtime included. Social-preview images are deployed and hashed but not necessary in the offline tool cache. Source/license notices for QPDF and its runtime dependencies are included. The license exporter now skips optional platform packages absent on the current host.

The analytics dashboard now includes daily UTC summaries and CSV. `bash analytics/snapshot.sh` creates dated operator and public aggregate snapshots without publishing them. Public snapshots omit pilot codes/feedback. Session counts are not distinct people; selected files are not completed jobs; downloads requested are not proof of saved output. Byte totals and social-campaign attribution are not collected.

Pending human evidence: team plan review/submission, consent, recruiting 10+ eligible non-classmates (stretch 30), questionnaire translation/pilot, physical iOS/Android and laptop verification, four task outcomes and saved-output inspection, SUS/TAM, observed baseline comparisons, severity 3–4 defect closure/retests, P1–P5 and the final demo. No human test result or passing grade is claimed.

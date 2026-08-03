# Security

This service handles passport data: document numbers, names, dates of birth.
Under GDPR that is ordinary personal data, but it is the kind whose disclosure
enables identity fraud. So the target is not "encrypted at rest". It is that
nothing comes to rest at all.

## Design principle

There is no database, no object storage, no cache, no temp file, and no log
line containing document data anywhere in this system. Breaching the running
container gets you the images currently in flight and nothing more. There is no
historical corpus to steal, because one was never created.

Every control below follows from that.

## Threat model

| Threat | Control | Where |
| --- | --- | --- |
| Decoded data leaks into a shared channel | DM-only intake by default; ephemeral replies in allow-listed channels | `slack/handlers/imageUpload.ts` |
| Data persists past the request | In-memory only; buffer zeroed in `finally` | `security/imageGuards.ts`, `slack/handlers/imageUpload.ts` |
| Data leaks via logs | Key-based redaction at the pino transport; sidecar logs counts and timings only | `logger.ts`, `ocr/app/main.py` |
| SSRF via a crafted event payload | File URLs must be HTTPS on `files.slack.com`; redirects refused | `slack/download.ts` |
| Malicious file disguised as an image | Type from magic bytes, not filename or reported MIME; SVG and PDF refused | `security/imageGuards.ts` |
| Decompression bomb | Byte cap before download completes; pixel budget checked at decode | `slack/download.ts`, `ocr/preprocess.py` |
| Resource exhaustion | Per-user rate limit, bounded job queue, capped repair search | `security/rateLimit.ts`, `mrz/repair.ts` |
| Inbound network attack | Socket Mode, so no listening port and no public IP | `slack/app.ts`, `fly.toml` |
| Sidecar reached from outside | Bound to `127.0.0.1`; never published | `docker/entrypoint.sh` |
| Wrong data reported as correct | Check digits verified on every path, including the AI fallback | `mrz/td3.ts`, `pipeline/extract.ts` |
| Data leaves the perimeter unnoticed | AI fallback off by default; config refuses to start half-configured | `config.ts` |
| Secrets in the image or repo | `.env` git-ignored and docker-ignored; secrets injected at runtime | `.gitignore`, `.dockerignore` |
| Vulnerable dependencies | Trivy gate on HIGH/CRITICAL in CI | `.github/workflows/ci.yml` |

## Correctness as a security property

A misread passport number that looks plausible is worse than no answer, because
it propagates quietly into whatever consumes it. The mitigation is labelling
rather than suppression.

Every field goes out with whether its check digit verified. A verified field is
exact. An unverified one is delivered with a warning that names it. Withholding
it entirely turned out to be unusable: ordinary photographs routinely lose a
single field, and refusing the whole reading over one bad character meant the
bot answered almost nothing.

That accepts a real risk, and it should be stated rather than buried. An
unverified field may be wrong while looking entirely reasonable. A consumer
that ignores the warning and treats every returned field as confirmed has
defeated the control. If you automate anything on top of this bot, branch on
the per-field validation flags, not on whether a result came back.

The vision fallback faces the same check digits, so a hallucinated document
number cannot be presented as verified. Its unverified fields are delivered
with the warning rather than discarded, for the same reason as above. Worth
remembering that a model's guess looks more plausible than OCR noise without
being any more reliable.

The guarantee also stops short of the name. Check digits cover the document
number, the dates, sex and the personal number. The document code, issuing
state and the holder's name have no check digit in either supported format;
they are reconstructed by weighted majority across the OCR variants and can
still be wrong. The reply says so. Treat a returned name as a best reading that
needs human confirmation.

The user-facing failure message is blunt for the same reason. "I could not read
this" is a safe outcome. "Probably TKACHENKO" is not.

## What this design does not do

These are decisions, not oversights.

It does not verify authenticity. The bot reads what is printed. It does not
check the chip, the digital signature, or any security feature, and cannot tell
a genuine passport from a photograph of a forgery.

It keeps no audit trail of who scanned what. An audit log of document accesses
is itself a sensitive dataset. If compliance requires one, log the user id and
timestamp only, never the document, and give it a short retention.

Slack still retains the uploaded image. The file lives in the workspace under
Slack's own retention policy. The bot never deletes it, because `files:write`
is a far more dangerous scope than the read access it needs. Configure
workspace retention accordingly, and prefer DMs that users can clear
themselves.

Memory zeroing is best effort. The GC may have copied the buffer before
`scrub()` runs, so treat it as defence in depth and not an erasure guarantee.

## Before enabling the AI fallback

`AI_FALLBACK_ENABLED=true` is the only path on which document images leave the
deployment. Treat turning it on as a data-processing decision rather than a
config tweak:

1. Confirm a data processing agreement covers the provider.
2. Confirm the workspace's users have been told.
3. Consider leaving it off and asking users to retake unreadable photos. The
   deterministic path plus check-digit repair handles most real uploads.

## Handling test data

Never commit a real document image. `.gitignore` blocks raster formats across
the repository for exactly this reason, and both test suites build their
fixtures in memory. The only document data in the repository is the published
ICAO/Wikipedia specimen, which uses the reserved number `XX000000`.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Please
don't open a public issue.

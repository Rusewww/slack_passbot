# Security

This service handles passport data: identity document numbers, names, dates of
birth. Under GDPR that is ordinary personal data, but it is the kind whose
disclosure enables identity fraud, so the design target is not "encrypted at
rest" — it is **no rest**.

## Design principle

> The safest data is data you never keep.

There is no database, no object storage, no cache, no temp file, and no log
line containing document data anywhere in this system. A breach of the running
container yields the images currently in flight and nothing else. There is no
historical corpus to exfiltrate because one was never created.

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
| Inbound network attack | Socket Mode — no listening port, no public IP | `slack/app.ts`, `fly.toml` |
| Sidecar reached from outside | Bound to `127.0.0.1`; never published | `docker/entrypoint.sh` |
| Wrong data reported as correct | All five check digits must verify, on every path including the AI fallback | `mrz/td3.ts`, `pipeline/extract.ts` |
| Data leaves the perimeter unnoticed | AI fallback off by default; config refuses to start half-configured | `config.ts` |
| Secrets in the image or repo | `.env` git-ignored and docker-ignored; secrets injected at runtime | `.gitignore`, `.dockerignore` |
| Vulnerable dependencies | Trivy gate on HIGH/CRITICAL in CI | `.github/workflows/ci.yml` |

## Correctness as a security property

A misread passport number that *looks* plausible is worse than no answer: it
propagates silently into whatever process consumes it. The pipeline therefore
refuses to emit a result unless every check digit verifies, and the vision
fallback is held to the identical standard — a hallucinated document number
fails the arithmetic and is discarded rather than delivered.

The user-facing failure message says so explicitly, because "I could not read
this" is a safe outcome and "probably TKACHENKO" is not.

## What this design does not do

Stated plainly, so the gaps are decisions rather than oversights:

- **No authenticity verification.** The bot reads what is printed. It does not
  check the chip, the digital signature, or any security feature, and cannot
  tell a genuine passport from a photograph of a forgery.
- **No audit trail of who scanned what.** Deliberate — an audit log of document
  accesses is itself a sensitive dataset. If compliance requires one, log the
  user id and timestamp only, never the document, and give it a short retention.
- **Slack retains the uploaded image.** The file lives in the workspace under
  Slack's own retention policy; the bot never deletes it, since `files:write`
  would be a far more dangerous scope than the read access it needs. Configure
  workspace retention accordingly, and prefer DMs that users can clear.
- **Memory zeroing is best-effort.** The GC may have copied the buffer before
  `scrub()` runs. It is defence in depth, not an erasure guarantee.

## Before enabling the AI fallback

`AI_FALLBACK_ENABLED=true` is the only path on which document images leave the
deployment. Treat turning it on as a data-processing decision, not a config
tweak:

1. Confirm a data processing agreement covers the provider.
2. Confirm the workspace's users have been told.
3. Prefer leaving it off and asking users to retake unreadable photos — the
   deterministic path plus check-digit repair handles the large majority of
   real uploads.

## Handling test data

Never commit a real document image. `.gitignore` blocks raster formats
repository-wide for exactly this reason, and both test suites synthesise their
fixtures in-process. The only document data in the repository is the published
ICAO/Wikipedia specimen, which uses the reserved number `XX000000`.

## Reporting

Report suspected vulnerabilities privately to the repository owner. Do not open
a public issue.

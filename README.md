# passbot

A Slack bot that reads the machine readable zone (MRZ) from a photo of a travel
document and returns the decoded data as a single line.

```
P/UKR/XX000000/UKR/24AUG91/F/25SEP23/TKACHENKO/MARIANA
```

Fields, in order: document code, issuing state, document number, nationality,
date of birth, sex, date of expiry, surname, given names.

> The fourth field is the ICAO **nationality** code. The MRZ does not encode
> place of birth — that appears only in the visual zone of the document.

## How it works

The MRZ is not free-form text. It is a fixed [ICAO 9303][icao] layout in OCR-B,
with **check digits** over the document number, date of birth, date of expiry
and a composite across the rest. Two layouts are supported:

| Format | Used by | Shape | Name field |
| --- | --- | --- | --- |
| **TD3** | passports | 2 lines × 44 | line 1 |
| **TD1** | identity cards | 3 lines × 30 | line 3 |

Both decode to the same nine output fields, so the reply looks identical
whichever document you send.

That changes the problem. Instead of trusting a recogniser's confidence score,
the bot can verify arithmetically whether a reading is correct, and correct it
when it is not:

| Stage | What it does | Where it runs |
| --- | --- | --- |
| 1. Localise + OCR | OpenCV finds and deskews the MRZ strip; Tesseract reads it under an `A-Z0-9<` whitelist | in the container |
| 2. Check-digit repair | Enumerates OCR-B glyph confusions (`0/O`, `1/I`, `5/S`, `8/B`, …) and keeps only readings that satisfy every check digit | in the container |
| 3. Vision fallback | A vision model transcribes the MRZ, then faces the *same* check-digit gate | external API; opt-in, off by default |

Stage 2 is what keeps most photographs on the deterministic path: a single
ambiguous glyph is usually solvable algebraically from the check digits rather
than by asking a bigger model.

Where a check digit *does* verify, the field is exact. Where it does not, the
bot still reports what it read — refusing outright made it useless on ordinary
photographs — but says so plainly, naming which checks held and which did not,
so a partly-damaged strip still yields the fields it can prove:

> :warning: **Some check digits did not verify — treat this reading as unconfirmed.**
> Failed: **date of expiry**. Compare those fields against the document before using them.

Each field carries its own check digit independently of the composite, so an
unreadable expiry date does not cast doubt on a document number that verified
exactly.

### What the check digits do *not* cover

The check digits cover the document number, the dates and a composite — and
nothing else. The document code, issuing state and the holder's **name** carry
no check digit of any kind (TD3 puts them on line 1, TD1 splits them between
line 1 and line 3). Those fields cannot be proven, only judged plausible.

They are therefore reconstructed differently: the OCR sidecar returns one
reading per preprocessing variant, and line 1 is rebuilt field-by-field by
weighted majority across all of them, weighted by structural plausibility
(see [`src/mrz/line1.ts`](src/mrz/line1.ts)). It is redundancy standing in for
proof, and it is genuinely weaker — a name is a best reading, not a verified
one, and the reply says so.

## Architecture

```
Slack ──outbound WebSocket──▶ Node / Bolt (TypeScript)
                                 │  download to memory, validate magic bytes
                                 ▼
                          Python sidecar on 127.0.0.1
                          OpenCV localisation → Tesseract → N candidates
                                 │
                                 ▼
                          src/mrz: parse → verify → repair
                                 │
                                 ▼
                          private reply to the uploader
```

Both processes live in one container and talk over loopback. The sidecar is
deliberately unaware of MRZ semantics — it returns every preprocessing variant
it produced and lets TypeScript adjudicate, so check-digit logic exists in
exactly one place.

**Socket Mode** means the service exposes no inbound port: no public URL, no
request-signature handling, nothing for a scanner to find.

| Path | Contents |
| --- | --- |
| `src/mrz/` | TD1 and TD3 parsing, check digits, confusion repair, name consensus, formatting |
| `src/slack/` | Bolt wiring, intake handler, file download, reply construction |
| `src/pipeline/` | Stage orchestration and candidate adjudication |
| `src/security/` | Magic-byte validation, size limits, rate limiting |
| `ocr/app/` | FastAPI sidecar: MRZ localisation and Tesseract |

## Security summary

- **DM-only by default.** Decoded passport data structurally cannot land in a
  shared channel. In allow-listed channels replies are ephemeral.
- **Nothing is stored.** No database, no object storage, no temp files. Images
  are processed in memory and the buffer is zeroed afterwards.
- **Nothing is logged.** The logger redacts every MRZ and field key at the
  transport level; logs carry outcome, timing and correlation ids only.
- **Only Slack's file host is fetched**, over HTTPS, with redirects refused —
  the URL arrives in an event payload and is treated as untrusted input.
- **Magic-byte type detection**, byte-size caps and a decoder pixel budget
  (decompression-bomb guard). SVG and PDF are refused.
- **The AI fallback is off by default** because it is the only path on which
  document data leaves the deployment.

Full detail and the threat model: [docs/SECURITY.md](docs/SECURITY.md).

## Running it

**Full setup, deployment and troubleshooting: [docs/RUNNING.md](docs/RUNNING.md).**
The quick version follows.

Prerequisites: Node 22+, Python 3.11+, Tesseract 5, Docker (optional).

```bash
cp .env.example .env    # then fill in SLACK_BOT_TOKEN and SLACK_APP_TOKEN
npm install
docker compose up -d ocr
npm run dev
```

Tests — no network, no images on disk, fixtures synthesised in-process:

```bash
npm test
```

```bash
cd ocr && pip install -e ".[dev]" && ruff check . && pytest
```

Run `ruff check` as well as `pytest` — CI gates on both, and `ruff` runs first,
so a lint error stops the tests from running at all.

### Slack app setup

Create an app at <https://api.slack.com/apps> from `manifest.yml`, then:

1. **Basic Information → App-Level Tokens**: generate a token with
   `connections:write`. This is `SLACK_APP_TOKEN`.
2. **Socket Mode**: enable.
3. **OAuth & Permissions**: install to the workspace; copy the bot token into
   `SLACK_BOT_TOKEN`. Scopes needed: `files:read`, `chat:write`, `im:write`,
   `im:history`.
4. **Event Subscriptions**: subscribe to `message.im`.

### Deploying

```bash
fly secrets set SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-…
fly deploy
```

One 512 MB always-on machine, no public IP, no database, no queue. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why serverless is a worse fit
here.

[icao]: https://www.icao.int/publications/pages/publication.aspx?docnum=9303

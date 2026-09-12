# Running and deploying passbot

Written for Windows 11 with PowerShell, which is where this was developed. The
Docker and Fly paths are platform independent.

If you just want to watch MRZ decoding work, skip to
[Step 3](#step-3-smoke-test-without-slack). It needs no Slack app and no
deployment.

---

## Step 0. Get the code

```bash
git checkout main
```

```bash
npm install
```

---

## Step 1. Create the Slack app

Required for anything involving Slack, though not for the smoke test in Step 3.

1. Go to <https://api.slack.com/apps>, choose Create New App, then From a
   manifest.
2. Pick your workspace, choose the YAML tab, and paste the contents of
   [`manifest.yml`](../manifest.yml). Create the app. This turns on Socket Mode
   and subscribes to `message.im` for you.
3. Under Basic Information, App-Level Tokens, choose Generate Token and Scopes.
   Name it anything (`socket` will do), add the `connections:write` scope, and
   generate. The `xapp-…` value is your `SLACK_APP_TOKEN`.
4. Under Install App, install to the workspace and allow. The Bot User OAuth
   Token, `xoxb-…`, is your `SLACK_BOT_TOKEN`.

Both tokens are secrets. They belong in `.env` locally (git-ignored) or in
`fly secrets` in production, never in a committed file.

### Create your `.env`

```bash
cp .env.example .env
```

Fill in `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. Everything else has a working
default. Leave `AI_FALLBACK_ENABLED=false` for now, and read
[SECURITY.md](SECURITY.md) before turning it on.

---

## Step 2. Start the OCR sidecar

The bot decodes nothing without it. Pick option A or option B.

### Option A: Docker (fewer moving parts)

Docker Desktop has to be running, not merely installed.

```bash
docker compose up -d ocr
```

The first build takes several minutes, since it compiles the TypeScript and
installs OpenCV and Tesseract. Check it came up:

```bash
docker compose ps
```

Then confirm the sidecar answers:

```bash
curl http://127.0.0.1:8000/health
```

You want `{"status":"ok","tesseract_lang":"mrz"}`.

### Option B: native Windows (no Docker)

Start with Tesseract itself. The sidecar cannot OCR without it.

```bash
winget install --id tesseract-ocr.tesseract -e
```

Make sure the installer adds it to PATH, then open a new shell and check. The
PATH change won't reach shells that were already open.

```bash
tesseract --version
```

Next the MRZ model, which is what decides whether names come out right.

Tesseract's `eng` model has no OCR-B chevron in its training data, so it cannot
produce `<` and emits `K`, `E`, `S` or `C` instead. A name field is mostly
filler, so with `eng` alone surnames get split on invented separators and the
padding turns into runs of letters, while the numeric fields read perfectly. A
document whose numbers are right and whose name is nonsense is the signature of
a missing MRZ model.

The Docker image installs it for you. On a native setup, download it next to
the other models:

```bash
curl -fsSL https://raw.githubusercontent.com/DoubangoTelecom/tesseractMRZ/1e7adfecda5f3c9ae1fb12cf6b4b8c3958c63e46/tessdata_best/mrz.traineddata -o "C:\Program Files\Tesseract-OCR\tessdata\mrz.traineddata"
```

That path needs an elevated shell. Check the file is 11,396,382 bytes, then ask
the sidecar what it loaded. This is the authoritative check:

```bash
curl http://127.0.0.1:8000/health
```

`{"status":"ok","tesseract_lang":"mrz"}` means the model is in use. `"eng"`
means it isn't, and names will be unreliable however good the photograph.

Then Python. From the `ocr/` directory:

```bash
python -m venv .venv
```

```bash
.venv\Scripts\python.exe -m pip install "fastapi>=0.115" "uvicorn[standard]>=0.34" "pydantic>=2.10" "opencv-python-headless>=4.11" "numpy>=2.1" "pytesseract>=0.3.13"
```

Run it, still from `ocr/`. The module path is `app.main:app` here; the
`ocr.app.main:app` form is for running from the repository root.

```bash
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Leave that running in its own terminal and verify from another:

```bash
curl http://127.0.0.1:8000/health
```

---

## Step 3. Smoke test without Slack

The fastest way to see the pipeline work. Point it at any passport photo whose
MRZ, the lines of `<<<` along the bottom, is legible:

```bash
curl -X POST --data-binary "@passport.jpg" -H "content-type: image/jpeg" http://127.0.0.1:8000/v1/recognise
```

You get back every preprocessing variant the sidecar tried, what Tesseract made
of each, and how long each call took. This is the raw OCR layer, with no
check-digit validation; that happens on the Node side. It's the quickest way to
judge whether a photo is readable at all before blaming the bot.

If you have no photo to hand, the specimen from Wikipedia's "Ukrainian
passport" article is the same document the test fixtures use.

---

## Step 4. Start the bot

With the sidecar running, from the repository root:

```bash
npm run dev
```

On success you'll see the build it's running, then the connection:

```
{"level":30,"service":"passbot","commit":"1948e9bd0b4c","running":"src","msg":"build"}
{"level":30,"service":"passbot","intakeMode":"dm_only","aiFallback":false,"msg":"passbot connected to Slack"}
```

Now in Slack, open a direct message with the app (look under Apps in the
sidebar) and send it a passport photo.

The bot ignores images posted in channels by default. That's deliberate: it
makes it impossible for decoded passport data to appear where a channel can see
it. To allow specific channels, set `INTAKE_MODE=allowlist` and
`ALLOWED_CHANNEL_IDS=C0123,C0456`. Replies there are ephemeral.

### What a successful reply looks like

````
```
P/UKR/XX000000/UKR/24AUG91/F/25SEP23/TKACHENKO/MARIANA
```
All check digits verified · name never check-digit protected · direct read · Not stored, this message is the only copy. · build 1948e9bd0b4c (src)
````

If the photo needed correcting you'll also see `read with check-digit
correction` and how many characters were repaired.

### When some check digits fail

You still get the reading, led by a warning naming what failed:

````
⚠️ *Some check digits did not verify. Treat this reading as unconfirmed.*
Failed: *date of expiry*. Compare those fields against the document before using them.

```
P/UKR/XX000000/UKR/24AUG91/F/25SEP23/TKACHENKO/MARIANA
```
Check digits confirmed for: document number, date of birth, personal number. A confirmed field is exact.

Partly verified · name never check-digit protected · direct read · Not stored, this message is the only copy.
````

That's working as intended. Each field carries its own check digit, so an
unreadable expiry date says nothing about a document number that verified
exactly, and refusing the whole reading over one bad character made the bot
useless on ordinary photographs.

The distinction is load bearing rather than boilerplate. A field listed as
confirmed is exact. A field listed as failed may be wrong while looking
entirely reasonable, so check it against the document. And the name is never
check-digit protected in any MRZ format. It comes from a majority vote across
the OCR variants, so verify it by eye even when everything else passes.

---

## Step 5. Deploy to Fly.io

```bash
winget install --id Fly-io.flyctl -e
```

```bash
fly auth login
```

Fly app names are globally unique, so `passbot` in [`fly.toml`](../fly.toml) is
almost certainly taken. Pick your own and edit the `app = ` line to match:

```bash
fly apps create passbot-yourname
```

Set the secrets before deploying. The app validates its configuration at boot
and exits if a token is missing, so deploying first only gets you a crash loop:

```bash
fly secrets set SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-...
```

```bash
fly deploy
```

Fly builds the image on a remote builder, so you don't need Docker running
locally for this.

```bash
fly logs
```

There is no public URL, and that's correct. Socket Mode dials out to Slack, so
the app has no inbound port and no public IP. `fly.toml` has no `[[services]]`
section for that reason. Don't add one.

### Machine sizing

One `shared-cpu-1x` machine with 512 MB, always on, no database and no queue.
Don't enable auto-stop, because the process has to stay connected to Slack to
receive events. 256 MB is not enough; OpenCV needs headroom to decode large
photographs.

---

## Troubleshooting

**`Invalid environment configuration: SLACK_BOT_TOKEN: Expected a bot token`**
`.env` is missing, or the token is in the wrong field. `xoxb-` is the bot token
and `xapp-` is the app-level token; swapping them produces exactly this error.

**The bot logs `passbot connected to Slack` but never replies to a DM.**
Check that Event Subscriptions includes `message.im` and that the `im:history`
scope is granted. If you added scopes after installing, reinstall the app to
the workspace.

**Sidecar returns HTTP 500 with `TesseractNotFoundError` in the log.**
Tesseract is not installed, or not on PATH. Check with `tesseract --version` in
a fresh shell. This is the most common failure on the native Windows path.
Note that `/health` still returns `ok`, because it doesn't shell out to
Tesseract, so a healthy sidecar doesn't prove OCR works.

**Numbers and dates read correctly but the name is nonsense.**
The MRZ model isn't loaded. `curl http://127.0.0.1:8000/health` and look at
`tesseract_lang`: `eng` cannot emit `<` at all, so no amount of image quality
will fix the name. See Step 2.

**Every photo fails with "check digits did not verify".**
Usually the photo rather than the bot. Both MRZ lines need to be fully in
frame, in focus and shot straight on. Run the photo through Step 3 to see what
Tesseract actually read.

**`OCR sidecar is not responding yet` on startup.**
A warning, not fatal. The bot starts anyway and uploads fail until the sidecar
is up. Start the sidecar, then restart the bot.

**Behaviour doesn't match the source you're reading.**
Check the `commit` and `running` fields in the startup log, and the build stamp
in the bot's reply. `npm start` rebuilds first, but a Docker image or a
long-running process can be older than your working tree.

---

## What is not verified yet

Tesseract has never been run against a real passport photograph in this
project. The test suites cover MRZ parsing, check digits, repair, image
localisation and the OCR call budget, but recognition accuracy on real images
is unmeasured. Step 3 is the fastest way to start measuring it.

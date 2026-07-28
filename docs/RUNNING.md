# Running and deploying passbot

Written for Windows 11 + PowerShell, which is where this was developed. The
Docker and Fly paths are platform-independent.

Read [Step 3](#step-3-smoke-test-without-slack) first if you just want to see
MRZ decoding work — it needs no Slack app and no deployment.

---

## Step 0 — Get the code

The current fixes live on a branch that has not been merged yet:

```bash
git checkout fix/trivy-strip-build-tooling-from-runtime
```

```bash
npm install
```

---

## Step 1 — Create the Slack app

This is required for anything involving Slack, but **not** for the smoke test in
Step 3.

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace, choose the **YAML** tab, and paste the contents of
   [`manifest.yml`](../manifest.yml). Create the app.
   - This turns on Socket Mode and subscribes to `message.im` for you.
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**
   - Name it anything (e.g. `socket`), add the scope **`connections:write`**,
     generate.
   - Copy the `xapp-…` value → this is `SLACK_APP_TOKEN`.
4. **Install App → Install to Workspace → Allow**
   - Copy the **Bot User OAuth Token**, `xoxb-…` → this is `SLACK_BOT_TOKEN`.

Both tokens are secrets. They go in `.env` locally (git-ignored) or into
`fly secrets` in production — never into a committed file.

### Create your `.env`

```bash
cp .env.example .env
```

Fill in `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. Everything else has a working
default. Leave `AI_FALLBACK_ENABLED=false` for now — see
[SECURITY.md](SECURITY.md) before turning it on.

---

## Step 2 — Start the OCR sidecar

The bot will not decode anything without it. Pick **A** or **B**.

### Option A — Docker (fewer moving parts)

Requires Docker Desktop to be **running** (not just installed).

```bash
docker compose up -d ocr
```

First build takes several minutes — it compiles the TypeScript and installs
OpenCV and Tesseract. Check it came up:

```bash
docker compose ps
```

Then confirm the sidecar answers:

```bash
curl http://127.0.0.1:8000/health
```

Expected: `{"status":"ok","tesseract_lang":"eng"}`

### Option B — Native Windows (no Docker)

**Install Tesseract.** This is not optional; the sidecar cannot OCR without it.

```bash
winget install --id tesseract-ocr.tesseract -e
```

During the installer, make sure it is added to PATH. Then open a **new** shell
and verify — the PATH change does not apply to shells already open:

```bash
tesseract --version
```

**Set up Python.** From the `ocr/` directory:

```bash
python -m venv .venv
```

```bash
.venv\Scripts\python.exe -m pip install "fastapi>=0.115" "uvicorn[standard]>=0.34" "pydantic>=2.10" "opencv-python-headless>=4.11" "numpy>=2.1" "pytesseract>=0.3.13"
```

**Run it.** Still from `ocr/` — the module path is `app.main:app` here, not
`ocr.app.main:app` (that form is for running from the repository root):

```bash
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Leave this running in its own terminal and verify from another:

```bash
curl http://127.0.0.1:8000/health
```

---

## Step 3 — Smoke test without Slack

The fastest way to see the pipeline work. Point it at any passport photo whose
MRZ (the two lines of `<<<` along the bottom) is legible:

```bash
curl -X POST --data-binary "@passport.jpg" -H "content-type: image/jpeg" http://127.0.0.1:8000/v1/recognise
```

You get back every preprocessing variant the sidecar tried and what Tesseract
made of each. This is the raw OCR layer — no check-digit validation, which
happens on the Node side. Useful for judging whether a photo is readable at all
before blaming the bot.

If you have no photo to hand, the specimen from Wikipedia's
"Ukrainian passport" article is the same document the test fixtures use.

---

## Step 4 — Start the bot

With the sidecar running, from the repository root:

```bash
npm run dev
```

Expected on success:

```
{"level":30,"service":"passbot","intakeMode":"dm_only","aiFallback":false,"msg":"passbot connected to Slack"}
```

Now in Slack, open a **direct message** with the app (find it under *Apps* in the
sidebar) and send it a passport photo.

By default the bot ignores images posted in channels. That is deliberate — it
makes it structurally impossible for decoded passport data to appear where a
channel can see it. To allow specific channels, set `INTAKE_MODE=allowlist` and
`ALLOWED_CHANNEL_IDS=C0123,C0456`; replies there are ephemeral.

### What a successful reply looks like

````
```
P/UKR/XX000000/UKR/24AUG91/F/25SEP23/TKACHENKO/MARIANA
```
Number and dates check-digit verified · name unverified · direct read · Not stored — this message is the only copy.
````

If the photo needed correcting you will see `read with check-digit correction`
and how many characters were repaired. If the check digits cannot be satisfied
the bot reports failure rather than a reading it cannot prove — that is working
as intended, not a bug.

**"name unverified" is literal, not boilerplate.** Every TD3 check digit is
computed over line 2, so the document number, dates and sex are provable. The
name lives on line 1, which has no check digit at all; it is reconstructed by
majority vote across the OCR variants and can still be wrong. Check the name
against the document by eye before relying on it.

---

## Step 5 — Deploy to Fly.io

```bash
winget install --id Fly-io.flyctl -e
```

```bash
fly auth login
```

**Choose an app name.** Fly app names are globally unique, so `passbot` in
[`fly.toml`](../fly.toml) is almost certainly taken. Pick your own and edit the
`app = ` line to match:

```bash
fly apps create passbot-yourname
```

**Set the secrets before deploying.** The app validates its configuration at
boot and exits if a token is missing, so deploying first just gets you a
crash loop:

```bash
fly secrets set SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-...
```

```bash
fly deploy
```

Fly builds the image on a remote builder, so you do **not** need Docker running
locally for this.

```bash
fly logs
```

There is no public URL, and that is correct — Socket Mode dials out to Slack, so
the app has no inbound port and no public IP. `fly.toml` has no `[[services]]`
section for exactly this reason. Do not add one.

### Machine sizing

One `shared-cpu-1x` machine with 512 MB, always on, no database and no queue.
Do not enable auto-stop — the process has to stay connected to Slack to receive
events. 256 MB is not enough; OpenCV needs headroom to decode large photographs.

---

## Troubleshooting

**`Invalid environment configuration: SLACK_BOT_TOKEN: Expected a bot token`**
`.env` is missing, or the token is in the wrong field. `xoxb-` is the bot token,
`xapp-` is the app-level token; swapping them produces exactly this error.

**Bot logs `passbot connected to Slack` but never replies to a DM**
Check `Event Subscriptions` includes `message.im` and that the `im:history`
scope is granted. If you added scopes after installing, you must reinstall the
app to the workspace.

**Sidecar returns HTTP 500, log shows `TesseractNotFoundError`**
Tesseract is not installed or not on PATH. Verify with `tesseract --version` in
a fresh shell. This is the most common failure on the native Windows path —
`/health` still returns `ok` because it does not shell out to Tesseract, so a
healthy sidecar does not prove OCR works.

**Every photo fails with "check digits did not verify"**
Usually the photo, not the bot. Both MRZ lines must be fully in frame, in focus,
shot straight-on. Run the photo through Step 3 to see what Tesseract actually
read. The stock `eng` model is serviceable but not great on OCR-B; dropping an
`mrz.traineddata` into the image's tessdata directory is the single biggest
accuracy improvement available and needs no code change (see
[ARCHITECTURE.md](ARCHITECTURE.md)).

**`OCR sidecar is not responding yet` on startup**
A warning, not fatal — the bot starts anyway and uploads will fail until the
sidecar is up. Start the sidecar, then restart the bot.

---

## What is not verified yet

Tesseract has never been run against a real passport photograph in this project.
The test suites cover MRZ parsing, check digits, repair and image localisation,
but recognition accuracy on real images is unmeasured. Step 3 is the fastest way
to start measuring it.

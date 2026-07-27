# Architecture

## The decision that shapes everything else

The MRZ is self-verifying. ICAO 9303 TD3 puts check digits over the document
number, date of birth, date of expiry and personal number, plus a composite
digit over all of them. Given a reading, we can compute whether it is correct.

That inverts the usual OCR trade-off. Normally you buy accuracy — a better
model, a paid API, a human in the loop — because you cannot tell good output
from bad. Here we can, which means a cheap recogniser plus arithmetic beats an
expensive recogniser without it. Three consequences follow:

1. **Acceptance is binary, not probabilistic.** A result is returned only if
   all five check digits verify. Confidence scores are never consulted.
2. **Repair is cheap and safe.** OCR-B produces a small set of glyph confusions.
   Enumerating them and keeping only readings that satisfy the check digits
   recovers most imperfect scans for microseconds of CPU — no model call.
3. **The expensive path is rarely taken.** The vision fallback exists for
   genuinely bad photographs, and is off by default.

## Component layout

```
┌─────────────────────────────── container ───────────────────────────────┐
│                                                                         │
│  Node 22 / Bolt (TypeScript)          Python 3.12 / FastAPI             │
│  ┌───────────────────────────┐        ┌──────────────────────────────┐  │
│  │ slack/    intake, replies │        │ preprocess.py                │  │
│  │ security/ input guards    │ ─HTTP─▶│   locate MRZ, deskew,        │  │
│  │ pipeline/ orchestration   │  :8000 │   binarise → N variants      │  │
│  │ mrz/      parse+verify    │◀────── │ recognise.py  Tesseract      │  │
│  └───────────────────────────┘        └──────────────────────────────┘  │
│              │                                     loopback only        │
└──────────────┼──────────────────────────────────────────────────────────┘
               │ outbound WebSocket
               ▼
             Slack
```

### Why the sidecar knows nothing about MRZ

The sidecar returns *every* preprocessing variant it produced, with whatever
Tesseract made of each, and expresses no opinion about which is right. All
adjudication happens in `src/pipeline/extract.ts` against `src/mrz`.

The alternative — having Python validate check digits and return one answer —
would duplicate the MRZ specification in two languages, which is exactly the
kind of logic that drifts. Since validation is essentially free, running it
over a handful of candidates in one place costs nothing and keeps the standard
implemented once.

### Why one container, two processes

The CV work needs OpenCV and Tesseract, which are native and Python-shaped. The
Slack work needs Bolt, which is JavaScript-shaped. Splitting them across two
deployed services would add a network hop, a second thing to deploy, and an
authenticated channel to secure. Co-locating them behind loopback keeps the
trust boundary at the container edge, where it is easy to reason about.

The sidecar is a warm HTTP process rather than a subprocess spawned per request
because Python interpreter startup plus OpenCV import costs roughly a second —
per upload, that dominates the actual work.

## Why not serverless

Scale-to-zero looks like the cheapest option and is not, for this workload:

| Consideration | Effect |
| --- | --- |
| Slack's 3-second ack | Forces an ack-then-async split: two functions and a queue instead of one process. |
| Cloud Run CPU throttling | CPU is throttled after the response is sent, so background processing needs `--no-cpu-throttling` — which removes the scale-to-zero saving. |
| Cold starts | A container carrying OpenCV and Tesseract starts in seconds, on an interactive path. |
| Socket Mode | Incompatible with a request-scoped runtime; HTTP mode would mean a public endpoint and signature verification. |

An always-on 512 MB machine costs roughly $0–4/month, has no cold starts, needs
no queue, and exposes no inbound port. It is cheaper *and* simpler here. The
sidecar boundary is the natural seam if volume ever justifies splitting.

## Extension points

**Other document types.** `src/mrz/td3.ts` is TD3-specific by design (fixed
offsets, no heuristics). TD1 identity cards are three lines of 30 characters
and TD2 is two lines of 36; both belong in sibling modules with the same shape,
dispatched on line length. `_score()` in `preprocess.py` already tolerates
three-line blocks.

**Extended document numbers.** ICAO allows numbers longer than nine characters,
in which case position 10 holds `<` and the remainder overflows into the
personal number field. Ukrainian passports do not use this form, so it is not
implemented — see the note in `parseTd3`. Add it before onboarding an issuing
state that does.

**Higher volume.** Replace the in-process `p-queue` with a real queue and the
in-memory `RateLimiter` with a Redis sorted set. Both are isolated behind small
interfaces for this reason.

**Better OCR.** Dropping an OCR-B-specific `mrz.traineddata` into the image's
tessdata directory is picked up automatically by `recognise.py`; no code change.
This is the highest-leverage accuracy improvement available and costs nothing
at runtime.

## Testing

Both suites synthesise their fixtures in-process — the Python tests render a
document-like image with OpenCV, the TypeScript tests work from the published
ICAO specimen string. No image files exist in the repository, so there is no
risk of a real document being committed and no binary fixtures to review.

The check-digit tests are worked examples from the specimen, verified against
ICAO 9303 by hand rather than by recording whatever the implementation happened
to produce.

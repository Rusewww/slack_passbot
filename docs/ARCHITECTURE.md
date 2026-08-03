# Architecture

## Why check digits drive the design

The MRZ is self-verifying. ICAO 9303 TD3 puts check digits over the document
number, date of birth, date of expiry and personal number, plus a composite
digit over all of them. Given a reading, we can compute whether it is correct.

That inverts the usual OCR trade-off. Normally you reach for a stronger
recogniser, or a hosted API, or a human in the loop, because you cannot tell
good output from bad. Here we can, so a simple deterministic recogniser plus
arithmetic beats a stronger one without verification.

Trust is per field, and binary within a field. A check digit either holds or it
does not, and confidence scores never enter into it. Each field carries its own
check digit independently of the composite, so a reading is rarely
all-or-nothing: a damaged expiry date leaves a verified document number intact.

Results go out even when some checks fail, labelled with which ones did. The
original design refused anything short of complete verification. That was
correct in principle and unusable in practice, because ordinary photographs
routinely lose one field. The thing that must never happen is an unverified
field being presented as though it were proven.

Repair is cheap. OCR-B produces a small set of glyph confusions; enumerating
them and keeping only the readings that satisfy the check digits recovers most
imperfect scans in microseconds of CPU, with no model call. The vision fallback
exists for genuinely bad photographs and is off by default.

One scope note that runs through everything below: no MRZ format check-digits
the holder's name at all. See [The name has no check digits](#the-name-has-no-check-digits).

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

The sidecar returns every preprocessing variant it produced, with whatever
Tesseract made of each, and expresses no opinion about which is right. All
adjudication happens in `src/pipeline/extract.ts` against `src/mrz`.

The alternative, having Python validate check digits and return one answer,
would put the MRZ specification in two languages. That kind of duplicated logic
drifts. Validation is a few microseconds of arithmetic, so running it over a
handful of candidates in one place costs nothing much and keeps the standard
implemented once.

### The name has no check digits

This asymmetry is easy to miss and worth stating plainly. The check digits
cover the document number, the dates and a composite. Nothing else. Those
fields are provable; the document code, issuing state, surname and given names
are not covered by anything.

Where that unverifiable text sits depends on the format. TD3 keeps all of it on
line 1. TD1 splits it between line 3 and the first five characters of line 1.
The consequence is the same either way.

So picking both lines together from whichever variant happened to parse is a
mistake, and it caused a real bug: a variant can produce a flawless line 2 and
a badly corrupted line 1, and the check digits will certify the pair, because
they never looked at line 1. Nothing about that failure looks like a failure.

The two lines are chosen independently, from a pool of every line every variant
produced:

| | Line 2 | Line 1 |
| --- | --- | --- |
| Guarantee | provable | plausible only |
| Method | check digits, plus confusion repair | weighted majority vote per field |
| Chosen by | fewest substitutions among fully-valid candidates | structural score: `<` in the document code, issuing state matching nationality, filler ratio |

Voting works because the sidecar hands back several independent readings of the
same strip. The errors differ between readings while the correct characters
tend to repeat. Most of the damage is the filler `<` coming back as `K`, `E` or
`S`, since the stock `eng` Tesseract model has no OCR-B chevron. Line 1 is
mostly filler, so that noise lands in the padding after the name, where
per-field voting throws it away.

This is weaker than proof and should not be written up as if it were.
Installing the OCR-B model, described below, addresses the cause.

### Why one container, two processes

The CV work needs OpenCV and Tesseract, which are native and Python-shaped. The
Slack work needs Bolt, which is JavaScript-shaped. Splitting them into two
deployed services would add a network hop, a second thing to deploy, and an
authenticated channel to secure. Keeping them together behind loopback puts the
trust boundary at the container edge, which is easy to reason about.

The sidecar is a warm HTTP process rather than a subprocess per request because
Python startup plus the OpenCV import costs roughly a second. Per upload, that
dominates the actual work.

## Why not serverless

Scale-to-zero looks like the obvious fit for this workload. It isn't.

| Consideration | Effect |
| --- | --- |
| Slack's 3-second ack | Forces an ack-then-async split: two functions and a queue instead of one process. |
| Cloud Run CPU throttling | CPU is throttled once the response is sent, so background work needs `--no-cpu-throttling`, which keeps the instance allocated and defeats the point of scaling to zero. |
| Cold starts | A container carrying OpenCV and Tesseract takes seconds to start, on an interactive path. |
| Socket Mode | Incompatible with a request-scoped runtime. HTTP mode would mean a public endpoint and signature verification. |

An always-on 512 MB machine has no cold starts, needs no queue, and exposes no
inbound port. It is simply the less complicated arrangement. If volume ever
justifies splitting the service, the sidecar boundary is the natural seam.

## Extension points

### Other document types

TD3 (`td3.ts`, passports, 2×44) and TD1 (`td1.ts`, identity cards, 3×30) are
each format-specific by design, with fixed offsets and no heuristics, and both
produce the shared `MrzFields`. TD2 (2×36, used by some older cards and visas)
belongs in a third sibling module of the same shape. Dispatch is by line length
in `pipeline/extract.ts`, which tries TD3 and falls through to TD1.

The formats differ in where the unverifiable text sits. TD3 puts the document
code, issuing state and name together on line 1. TD1 keeps the code and state
on line 1, next to the check-digit-covered document number, and puts the name
alone on line 3. `names.ts` holds what the two have in common.

### Extended document numbers

ICAO allows numbers longer than nine characters. Position 10 then holds `<` and
the remainder overflows into the personal number field. Ukrainian passports
don't use that form, so it isn't implemented; there's a note in `parseTd3`. Add
it before onboarding an issuing state that does.

### Higher volume

Replace the in-process `p-queue` with a real queue and the in-memory
`RateLimiter` with a Redis sorted set. Both sit behind small interfaces for
this reason.

### Issuer formats

`mrz/issuers.ts` holds document number shapes per issuing state. It is the only
mechanism that can correct a substitution the check digits are blind to, which
means the digit/letter class `0↔A` through `9↔J`, `6↔G` among them. An
unrecognised issuer gets no constraint at all, so entries can only help the
issuers they name. Add one only when you have a real sample to justify it.

### The recognition model

The image installs `mrz.traineddata`, trained on OCR-B passport zones, pinned
to a commit and verified by SHA-256 in its own build stage. This is not a
refinement. The `eng` model has no chevron in its training data and cannot emit
`<` at all, so without the MRZ model a name field made mostly of filler is
unreadable in principle, however good the photograph. `recognise.py` probes for
it and falls back to `eng`, so a missing model costs accuracy rather than
breaking recognition, and `/health` reports which one is loaded.

## Testing

Both suites build their fixtures in memory. The Python tests render a
document-like image with OpenCV; the TypeScript tests work from the published
ICAO specimen string. No image files exist in the repository, so there is no
risk of committing a real document and no binary fixtures to review.

The check-digit tests are worked examples from the specimen, calculated against
ICAO 9303 by hand rather than recorded from whatever the implementation
happened to produce.

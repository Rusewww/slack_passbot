# Architecture

## The decision that shapes everything else

The MRZ is self-verifying. ICAO 9303 TD3 puts check digits over the document
number, date of birth, date of expiry and personal number, plus a composite
digit over all of them. Given a reading, we can compute whether it is correct.

That inverts the usual OCR trade-off. Normally you reach for a stronger
recogniser — a better model, a hosted API, a human in the loop — because you
cannot tell good output from bad. Here we can, which means a simple
deterministic recogniser plus arithmetic outperforms a stronger one without
verification. Three consequences follow:

1. **Trust is per field, and binary within a field.** A check digit either
   holds or it does not; confidence scores are never consulted. Because each
   field carries its own check digit independently of the composite, a reading
   is rarely all-or-nothing — a damaged expiry date leaves a verified document
   number entirely intact.

   Results are delivered even when some checks fail, labelled with exactly
   which ones did. That is a deliberate reversal of the original design, which
   refused anything short of complete verification: correct in principle,
   unusable in practice, because ordinary photographs frequently lose one
   field. What must never happen is an unverified field being presented as
   though it were proven.

   Note the scope: no MRZ format check-digits the holder's **name** at all
   (see [The name has no check digits](#the-name-has-no-check-digits)).
2. **Repair is safe and fast.** OCR-B produces a small set of glyph confusions.
   Enumerating them and keeping only readings that satisfy the check digits
   recovers most imperfect scans in microseconds of CPU — no model call.
3. **The heaviest path is rarely taken.** The vision fallback exists for
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
kind of logic that drifts. Validation is a few microseconds of arithmetic, so
running it over a handful of candidates in one place is negligible and keeps the
standard implemented once.

### The name has no check digits

This is the most important asymmetry in the system, and it is easy to miss:
**the check digits cover the document number, the dates and a composite, and
nothing else.** Those fields are provable. The document code, issuing state,
surname and given names are not covered by anything.

Where that unverifiable text sits depends on the format — all of TD3 line 1,
versus TD1's line 3 plus the first five characters of its line 1 — but the
consequence is identical in both.

Selecting both lines together from whichever preprocessing variant happened to
parse is therefore a mistake, and was a real defect: a variant can produce a
flawless line 2 and a badly corrupted line 1, and the check digits will
certify the pair, because they never looked at line 1. The failure is silent
and confident, which is the worst kind.

The two lines are now chosen independently from a pool of every line every
variant produced:

| | Line 2 | Line 1 |
| --- | --- | --- |
| Guarantee | provable | plausible only |
| Method | check digits, plus confusion repair | weighted majority vote per field |
| Chosen by | fewest substitutions among fully-valid candidates | structural score: `<` in the document code, issuing state matching nationality, filler ratio |

Voting works because the sidecar hands back several independent readings of the
same strip. Errors differ between them; the truth repeats. The dominant error
is the filler `<` being read as `K`, `E` or `S` — the stock `eng` Tesseract
model has no OCR-B chevron — and since line 1 is mostly filler, that noise
lands in the padding after the name, where per-field voting discards it.

This is weaker than proof and should not be described as if it were. Installing
the OCR-B model (below) is the real fix for the underlying cause.

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

Scale-to-zero looks like the obvious fit and is not, for this workload:

| Consideration | Effect |
| --- | --- |
| Slack's 3-second ack | Forces an ack-then-async split: two functions and a queue instead of one process. |
| Cloud Run CPU throttling | CPU is throttled after the response is sent, so background processing needs `--no-cpu-throttling` — which keeps the instance allocated anyway, defeating the point of scaling to zero. |
| Cold starts | A container carrying OpenCV and Tesseract starts in seconds, on an interactive path. |
| Socket Mode | Incompatible with a request-scoped runtime; HTTP mode would mean a public endpoint and signature verification. |

An always-on 512 MB machine has no cold starts, needs no queue, and exposes no
inbound port. It is the simpler arrangement here. The sidecar boundary is the
natural seam if volume ever justifies splitting.

## Extension points

**Other document types.** TD3 (`td3.ts`, passports, 2×44) and TD1 (`td1.ts`,
identity cards, 3×30) are each format-specific by design — fixed offsets, no
heuristics — and both produce the shared `MrzFields`. TD2 (2×36, used by some
older cards and visas) belongs in a third sibling module of the same shape.
Dispatch is by line length in `pipeline/extract.ts`, which tries TD3 and falls
through to TD1.

The two formats differ in where the unverifiable text sits: TD3 puts the
document code, issuing state and name together on line 1, whereas TD1 puts the
code and state on line 1 — alongside the check-digit-covered document number —
and the name alone on line 3. `names.ts` holds the part that is common to both.

**Extended document numbers.** ICAO allows numbers longer than nine characters,
in which case position 10 holds `<` and the remainder overflows into the
personal number field. Ukrainian passports do not use this form, so it is not
implemented — see the note in `parseTd3`. Add it before onboarding an issuing
state that does.

**Higher volume.** Replace the in-process `p-queue` with a real queue and the
in-memory `RateLimiter` with a Redis sorted set. Both are isolated behind small
interfaces for this reason.

**Issuer formats.** `mrz/issuers.ts` holds document number shapes per issuing
state. This is the only mechanism that can correct a substitution the check
digits are blind to — the digit/letter class `0↔A` … `9↔J`, `6↔G` among them.
An unrecognised issuer gets no constraint, so entries can only ever help the
issuers they name. Add one only with a real sample to justify it.

**The recognition model.** The image installs `mrz.traineddata`, trained on
OCR-B passport zones, pinned to a commit and verified by SHA-256 in its own
build stage. This is not a refinement — `eng` has no chevron in its training
data and physically cannot emit `<`, so without the MRZ model a name field
made mostly of filler is unreadable in principle, however good the photograph.
`recognise.py` probes for it and falls back to `eng`, so a missing model
degrades accuracy rather than breaking recognition; `/health` reports which one
is loaded.

## Testing

Both suites synthesise their fixtures in-process — the Python tests render a
document-like image with OpenCV, the TypeScript tests work from the published
ICAO specimen string. No image files exist in the repository, so there is no
risk of a real document being committed and no binary fixtures to review.

The check-digit tests are worked examples from the specimen, verified against
ICAO 9303 by hand rather than by recording whatever the implementation happened
to produce.

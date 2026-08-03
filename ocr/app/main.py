"""OCR sidecar.

Binds to loopback only. It has no authentication and needs none: the only
thing that can reach it is the Node process in the same container. Do not
publish this port.

The service is deliberately dumb. It does not know what a check digit is and
makes no judgement about which reading is correct. It returns every candidate
it produced and lets the caller adjudicate. That keeps all MRZ semantics in one
place (the TypeScript `src/mrz` module) instead of split across two languages.
"""

from __future__ import annotations

import logging
import time

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from . import recognise as engine
from .preprocess import (
    ImageTooLargeError,
    UndecodableImageError,
    build_candidates,
    decode,
    split_lines,
)
from .schemas import CandidateOut, HealthOut, RecogniseOut

DEFAULT_MAX_PIXELS = 40_000_000
MAX_BODY_BYTES = 12 * 1024 * 1024

# How many complete-looking readings to gather before stopping.
#
# One is not enough: the caller resolves disagreements by majority, and that
# vote is the only defence against substitutions the check digits are blind to
# (`6` for `G`, and the rest of the 0-A..9-J class). Three leaves room for a
# 2-1 decision. Raising it costs roughly 340 ms per extra reading.
QUORUM = 3

# No request body, no image dimensions, no recognised text. Nothing that could
# reconstruct a document ends up in the sidecar's logs either.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("passbot.ocr")

app = FastAPI(title="passbot OCR sidecar", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health", response_model=HealthOut)
async def health() -> HealthOut:
    return HealthOut(status="ok", tesseract_lang=engine.language())


@app.post("/v1/recognise", response_model=RecogniseOut)
async def recognise_endpoint(request: Request) -> Response:
    started = time.monotonic()

    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        return JSONResponse({"detail": "body too large"}, status_code=413)

    try:
        max_pixels = int(request.headers.get("x-max-pixels", DEFAULT_MAX_PIXELS))
    except ValueError:
        max_pixels = DEFAULT_MAX_PIXELS

    try:
        image = decode(body, max_pixels)
    except ImageTooLargeError as exc:
        log.info("rejected oversized image: %s", exc)
        return JSONResponse({"detail": "image too large"}, status_code=413)
    except UndecodableImageError:
        return JSONResponse({"detail": "undecodable image"}, status_code=415)
    finally:
        del body

    prepared = build_candidates(image)
    located = [c for c in prepared if c.variant.startswith("located:")]
    fallback = [c for c in prepared if not c.variant.startswith("located:")]

    candidates: list[CandidateOut] = []
    complete = 0

    def run(variant: str, image_or_rows) -> bool:
        """Recognises one variant, records it, and reports whether it looks whole."""
        nonlocal complete
        call_started = time.monotonic()
        result = (
            engine.recognise_lines(variant, image_or_rows)
            if isinstance(image_or_rows, list)
            else engine.recognise(variant, image_or_rows)
        )
        candidates.append(
            CandidateOut(
                variant=result.variant,
                text=result.text,
                lines=result.lines,
                ms=int((time.monotonic() - call_started) * 1000),
            )
        )
        if engine.looks_complete(result.lines):
            complete += 1
            return True
        return False

    # Tesseract accounts for over 99% of the time here, so the only thing worth
    # optimising is how many times it is called. Everything below exists to
    # avoid calls that will not change the answer.
    #
    # Stopping at the first complete reading would be wrong: the caller decides
    # between readings by majority, and that vote is what catches substitutions
    # the check digits cannot see. So gather a quorum, then stop.
    for candidate in located:
        run(candidate.variant, candidate.image)
        if complete >= QUORUM:
            break

    # Escalation, not routine work: reading line by line costs one call per
    # line and only earns its keep when reading the block whole did not produce
    # anything of the right shape.
    if complete < QUORUM:
        for candidate in located:
            rows = split_lines(candidate.image)
            if len(rows) < 2:
                continue
            run(f"{candidate.variant}+perline", rows)
            if complete >= QUORUM:
                break

    # Last resort. The bottom-of-page crop is for photographs where MRZ
    # localisation failed outright; if the located strip yielded anything
    # usable, this is guaranteed waste.
    if complete == 0:
        for candidate in fallback:
            run(candidate.variant, candidate.image)
            if complete >= QUORUM:
                break

    duration_ms = int((time.monotonic() - started) * 1000)
    log.info(
        "recognised %d candidate(s), %d complete, in %dms",
        len(candidates),
        complete,
        duration_ms,
    )

    return JSONResponse(
        RecogniseOut(
            candidates=candidates, durationMs=duration_ms, calls=len(candidates)
        ).model_dump()
    )

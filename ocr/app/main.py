"""OCR sidecar.

Binds to loopback only. It has no authentication and needs none: the only
thing that can reach it is the Node process in the same container. Do not
publish this port.

The service is deliberately dumb. It does not know what a check digit is and
makes no judgement about which reading is correct — it returns every candidate
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

# No request body, no image dimensions, no recognised text — nothing that could
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

    candidates: list[CandidateOut] = []
    for prepared in build_candidates(image):
        result = engine.recognise(prepared.variant, prepared.image)
        candidates.append(
            CandidateOut(variant=result.variant, text=result.text, lines=result.lines)
        )

        # Read the located strip a second time, one line at a time. Only for
        # the located variants: the bottom-of-page fallback contains unrelated
        # text whose rows would split into meaningless bands.
        if not prepared.variant.startswith("located:"):
            continue

        rows = split_lines(prepared.image)
        if len(rows) < 2:
            continue

        per_line = engine.recognise_lines(f"{prepared.variant}+perline", rows)
        if per_line.lines:
            candidates.append(
                CandidateOut(
                    variant=per_line.variant, text=per_line.text, lines=per_line.lines
                )
            )

    duration_ms = int((time.monotonic() - started) * 1000)
    log.info("recognised %d candidate(s) in %dms", len(candidates), duration_ms)

    return JSONResponse(
        RecogniseOut(candidates=candidates, durationMs=duration_ms).model_dump()
    )

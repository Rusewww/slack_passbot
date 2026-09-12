"""Wire types for the sidecar. Mirrored by `src/ocr/sidecar.ts`."""

from __future__ import annotations

from pydantic import BaseModel


class HealthOut(BaseModel):
    status: str
    tesseract_lang: str


class CandidateOut(BaseModel):
    """One preprocessing variant and what Tesseract made of it."""

    variant: str
    text: str
    lines: list[str]
    #: Wall time for this one Tesseract call, so the variant ordering can be
    #: tuned against measurements instead of intuition.
    ms: int = 0


class RecogniseOut(BaseModel):
    candidates: list[CandidateOut]
    durationMs: int  # noqa: N815 - matches the TypeScript client
    #: Tesseract invocations actually made. The figure worth watching: it is
    #: over 99% of the request's cost.
    calls: int = 0

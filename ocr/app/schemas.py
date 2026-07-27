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


class RecogniseOut(BaseModel):
    candidates: list[CandidateOut]
    durationMs: int  # noqa: N815 - matches the TypeScript client

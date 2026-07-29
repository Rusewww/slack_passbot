"""How many times Tesseract gets called.

Measured on this project: OCR is 99.4% of a request's wall time, and
preprocessing is under 40 ms. Call count *is* the performance characteristic,
so it is pinned here rather than left to drift.

Tesseract is stubbed out. These tests are about control flow, and stubbing also
means they run on a machine without Tesseract installed — which is where this
code is developed.
"""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main as sidecar
from app import recognise as engine

TD3 = ["P<UKRTKACHENKO<<MARIANA" + "<" * 21, "XX000000<0UKR9108242F23092571234567890<<<<70"]
GARBAGE = ["KKKK<<KKKK", "4M<XAPKIBCKAO6J1UKR"]


class Recorder:
    """Stands in for Tesseract, recording which variants were asked for."""

    def __init__(self) -> None:
        self.variants: list[str] = []
        self.complete = True

    def _reply(self, variant: str):
        self.variants.append(variant)
        lines = TD3 if self.complete else GARBAGE
        return engine.Recognition(variant=variant, text="\n".join(lines), lines=lines)

    def recognise(self, variant: str, image: np.ndarray):
        return self._reply(variant)

    def recognise_lines(self, variant: str, images):
        return self._reply(variant)


@pytest.fixture
def calls(monkeypatch) -> Recorder:
    recorder = Recorder()
    monkeypatch.setattr(sidecar.engine, "recognise", recorder.recognise)
    monkeypatch.setattr(sidecar.engine, "recognise_lines", recorder.recognise_lines)
    return recorder


def post(image_bytes: bytes) -> dict:
    with TestClient(sidecar.app) as client:
        response = client.post(
            "/v1/recognise", content=image_bytes, headers={"content-type": "image/png"}
        )
        assert response.status_code == 200, response.text
        return response.json()


@pytest.fixture
def page_bytes() -> bytes:
    import cv2

    from tests.test_preprocess import synthetic_passport

    ok, buffer = cv2.imencode(".png", synthetic_passport())
    assert ok
    return buffer.tobytes()


class TestCallBudget:
    def test_stops_at_the_quorum_when_readings_look_complete(self, calls, page_bytes) -> None:
        body = post(page_bytes)

        # Three, not one: the caller decides between readings by majority, and
        # that vote is the only defence against substitutions the check digits
        # cannot see. Three leaves room for a 2-1 decision.
        assert body["calls"] == sidecar.QUORUM
        assert len(calls.variants) == sidecar.QUORUM

    def test_never_reaches_the_fallback_crop_when_localisation_worked(
        self, calls, page_bytes
    ) -> None:
        post(page_bytes)

        assert all(variant.startswith("located:") for variant in calls.variants)
        assert not any("bottom:" in variant for variant in calls.variants)

    def test_does_not_read_line_by_line_when_the_block_read_is_whole(
        self, calls, page_bytes
    ) -> None:
        # Per-line recognition costs one call per line; it is an escalation.
        post(page_bytes)
        assert not any("perline" in variant for variant in calls.variants)

    def test_escalates_when_nothing_looks_complete(self, calls, page_bytes) -> None:
        calls.complete = False

        body = post(page_bytes)
        variants = body["candidates"]

        # Everything is tried before giving up, including per-line and the
        # bottom-of-page crop.
        assert any("perline" in c["variant"] for c in variants)
        assert any(c["variant"].startswith("bottom:") for c in variants)

    def test_reports_per_call_timing(self, calls, page_bytes) -> None:
        # So variant ordering can be tuned against measurements.
        body = post(page_bytes)
        assert all("ms" in candidate for candidate in body["candidates"])

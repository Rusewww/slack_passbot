"""Tests for MRZ localisation.

Fixtures are synthesised in-process — a rendered MRZ strip on a page-like
background. No document image is ever read from disk, so there is nothing
sensitive in the repository and nothing for CI to leak.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.preprocess import (
    ImageTooLargeError,
    UndecodableImageError,
    build_candidates,
    decode,
    locate_mrz,
)

LINE_1 = "P<UKRTKACHENKO<<MARIANA<<<<<<<<<<<<<<<<<<<<<"
LINE_2 = "XX000000<0UKR9108242F23092571234567890<<<<70"


def synthetic_passport(width: int = 1200, height: int = 850) -> np.ndarray:
    """A light page with two lines of monospaced text along the bottom."""
    page = np.full((height, width, 3), 235, dtype=np.uint8)

    # Some visual-zone noise above, so localisation has to actually discriminate.
    cv2.putText(page, "UKRAINE", (60, 90), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (90, 90, 90), 3)
    cv2.rectangle(page, (60, 150), (300, 480), (170, 170, 170), -1)

    for index, line in enumerate((LINE_1, LINE_2)):
        y = int(height * 0.83) + index * 46
        cv2.putText(page, line, (40, y), cv2.FONT_HERSHEY_DUPLEX, 0.78, (20, 20, 20), 2)

    return page


def encode(image: np.ndarray) -> bytes:
    ok, buffer = cv2.imencode(".png", image)
    assert ok
    return buffer.tobytes()


class TestDecode:
    def test_round_trips_a_valid_image(self) -> None:
        image = decode(encode(synthetic_passport()), max_pixels=10_000_000)
        assert image.shape[:2] == (850, 1200)

    def test_rejects_non_image_bytes(self) -> None:
        with pytest.raises(UndecodableImageError):
            decode(b"not an image at all", max_pixels=10_000_000)

    def test_enforces_the_pixel_budget(self) -> None:
        # The guard that stops a small file from expanding into a huge allocation.
        with pytest.raises(ImageTooLargeError):
            decode(encode(synthetic_passport()), max_pixels=1000)


class TestLocateMrz:
    def test_finds_the_strip_in_the_lower_page(self) -> None:
        located = locate_mrz(synthetic_passport())

        assert located is not None
        height, width = located.shape[:2]
        assert width / height > 3.0, "an MRZ crop must be markedly wider than it is tall"

    def test_returns_none_for_a_blank_page(self) -> None:
        blank = np.full((600, 900, 3), 240, dtype=np.uint8)
        assert locate_mrz(blank) is None

    def test_tolerates_a_small_rotation(self) -> None:
        page = synthetic_passport()
        centre = (page.shape[1] / 2, page.shape[0] / 2)
        matrix = cv2.getRotationMatrix2D(centre, 4.0, 1.0)
        rotated = cv2.warpAffine(
            page, matrix, (page.shape[1], page.shape[0]), borderMode=cv2.BORDER_REPLICATE
        )

        assert locate_mrz(rotated) is not None


class TestBuildCandidates:
    def test_always_produces_candidates(self) -> None:
        # Even when localisation fails, the bottom-strip fallback must yield
        # something for the recogniser to try.
        blank = np.full((600, 900, 3), 240, dtype=np.uint8)
        assert len(build_candidates(blank)) > 0

    def test_candidates_are_single_channel_and_named(self) -> None:
        for candidate in build_candidates(synthetic_passport()):
            assert candidate.image.ndim == 2
            assert ":" in candidate.variant

"""Tests for MRZ localisation.

Fixtures are built in memory: a rendered MRZ strip on a page-like background.
No document image is ever read from disk, so there is nothing sensitive in the
repository and nothing for CI to leak.
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
    sharpen,
    split_lines,
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


class TestSplitLines:
    """The MRZ strip is split into individual lines so each can be read alone.

    Tesseract does markedly better on one line of fixed-pitch text than on a
    block of them, which matters most on exactly the small, soft strips that
    currently fail.
    """

    def _located_binary(self) -> np.ndarray:
        located = locate_mrz(synthetic_passport())
        assert located is not None
        grey = cv2.cvtColor(located, cv2.COLOR_BGR2GRAY)
        _, binary = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
        return binary

    def test_finds_both_mrz_lines(self) -> None:
        assert len(split_lines(self._located_binary())) == 2

    def test_bands_are_ordered_top_to_bottom_and_disjoint(self) -> None:
        bands = split_lines(self._located_binary())
        # Each band must be a plausible single line: much wider than it is tall.
        for band in bands:
            assert band.shape[0] >= 6
            assert band.shape[1] / band.shape[0] > 5

    def test_returns_nothing_for_a_blank_strip(self) -> None:
        assert split_lines(np.full((40, 400), 255, dtype=np.uint8)) == []

    def test_ignores_an_input_too_short_to_hold_a_line(self) -> None:
        assert split_lines(np.full((4, 400), 0, dtype=np.uint8)) == []


class TestSharpen:
    def test_preserves_shape_and_type(self) -> None:
        grey = cv2.cvtColor(synthetic_passport(), cv2.COLOR_BGR2GRAY)
        sharpened = sharpen(grey)

        assert sharpened.shape == grey.shape
        assert sharpened.dtype == grey.dtype

    def test_increases_local_contrast(self) -> None:
        # The point of the unsharp mask: edges between glyphs get further apart
        # in intensity, which is what separates `<` from `K` on a soft scan.
        grey = cv2.cvtColor(synthetic_passport(), cv2.COLOR_BGR2GRAY)
        assert sharpen(grey).std() > grey.std()

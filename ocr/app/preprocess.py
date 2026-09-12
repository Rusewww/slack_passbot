"""Locating and conditioning the machine readable zone.

This module carries most of the accuracy of the system. Tesseract on a clean,
deskewed, high-contrast MRZ strip is close to perfect; Tesseract on a raw phone
photo is close to useless. Everything here exists to turn the second into the
first.

The strategy is deliberately to produce *several* candidate images rather than
one "best" guess. Deciding which one is right is fast and exact downstream,
since the check digits settle it, so handing the recogniser a handful of
plausible renderings beats committing early to a single threshold.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# A single MRZ line is 44 characters of a monospaced font, so it is extremely
# elongated, far more so than any caption or heading in the visual zone. That
# elongation is the primary discriminator.
MIN_BAR_ASPECT = 12.0
MIN_BAR_HEIGHT = 5.0
MIN_BAR_WIDTH_RATIO = 0.30  # of the page width
MIN_BAR_CENTRE_Y = 0.40  # MRZ sits in the lower part of the document

# Two consecutive MRZ lines are close together relative to their own height,
# and near-perfectly aligned horizontally.
MAX_LINE_GAP_RATIO = 5.0
MIN_X_OVERLAP = 0.6

# Tesseract's accuracy on OCR-B plateaus once the glyphs are ~30 px tall.
TARGET_STRIP_HEIGHT = 220

# Work at a bounded width: bigger inputs cost time without improving the read.
WORKING_WIDTH = 1600


class ImageTooLargeError(Exception):
    """Raised when a decoded image exceeds the configured pixel budget."""


class UndecodableImageError(Exception):
    """Raised when the bytes are not a decodable raster image."""


@dataclass(frozen=True)
class Candidate:
    """One rendering of the MRZ region, ready for OCR."""

    variant: str
    image: np.ndarray


def decode(data: bytes, max_pixels: int) -> np.ndarray:
    """Decodes image bytes to BGR, refusing decompression bombs.

    OpenCV allocates on decode, so the pixel budget is checked against the
    decoded result and the buffer is released immediately if it is too big.
    """
    buffer = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if image is None:
        raise UndecodableImageError("cv2 could not decode the supplied bytes")

    height, width = image.shape[:2]
    if height * width > max_pixels:
        del image
        raise ImageTooLargeError(f"{width}x{height} exceeds the {max_pixels} pixel budget")

    return image


def _to_working_size(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    if width <= WORKING_WIDTH:
        return image
    scale = WORKING_WIDTH / width
    return cv2.resize(
        image, (WORKING_WIDTH, int(height * scale)), interpolation=cv2.INTER_AREA
    )


@dataclass(frozen=True)
class _Bar:
    """One horizontal run of text, a candidate MRZ line."""

    contour: np.ndarray
    centre_y: float
    width: float
    height: float
    x0: float
    x1: float


def _text_mask(image: np.ndarray) -> np.ndarray | None:
    """Binary mask in which each line of text has become one solid bar.

    A blackhat transform isolates dark-on-light text regardless of the
    background's own brightness, a horizontal Sobel picks up the dense vertical
    stems that characterise a run of glyphs, and a wide-but-short closing melts
    the characters of a line together without bridging to the line below.
    """
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    grey = cv2.GaussianBlur(grey, (3, 3), 0)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 7))
    blackhat = cv2.morphologyEx(grey, cv2.MORPH_BLACKHAT, kernel)

    grad = np.absolute(cv2.Sobel(blackhat, ddepth=cv2.CV_32F, dx=1, dy=0, ksize=-1))
    span = float(grad.max() - grad.min())
    if span == 0:
        return None  # a blank image has no gradient to normalise
    grad = (255 * ((grad - grad.min()) / span)).astype(np.uint8)

    grad = cv2.morphologyEx(grad, cv2.MORPH_CLOSE, kernel)
    _, thresh = cv2.threshold(grad, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    return cv2.morphologyEx(
        thresh, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (21, 5))
    )


def _candidate_bars(mask: np.ndarray, page_height: int, page_width: int) -> list[_Bar]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    bars: list[_Bar] = []

    for contour in contours:
        (_, centre_y), (width, height), _ = cv2.minAreaRect(contour)
        if width < height:
            width, height = height, width
        if height < MIN_BAR_HEIGHT or width < page_width * MIN_BAR_WIDTH_RATIO:
            continue
        if width / max(height, 1.0) < MIN_BAR_ASPECT:
            continue
        if centre_y < page_height * MIN_BAR_CENTRE_Y:
            continue

        x, _, box_width, _ = cv2.boundingRect(contour)
        bars.append(
            _Bar(
                contour=contour,
                centre_y=centre_y,
                width=width,
                height=height,
                x0=float(x),
                x1=float(x + box_width),
            )
        )

    return bars


def _x_overlap(a: _Bar, b: _Bar) -> float:
    """Fraction of the narrower bar that overlaps the wider one horizontally."""
    overlap = min(a.x1, b.x1) - max(a.x0, b.x0)
    narrower = min(a.x1 - a.x0, b.x1 - b.x0)
    return overlap / narrower if narrower > 0 else 0.0


def _group_bars(bars: list[_Bar]) -> list[list[_Bar]]:
    """Clusters bars that read as consecutive lines of the same block.

    Grouping rather than morphological merging is what makes this robust to
    line spacing: a closing kernel large enough to bridge a wide gap on one
    document will swallow unrelated text on another.
    """
    groups: list[list[_Bar]] = []

    for bar in sorted(bars, key=lambda b: b.centre_y):
        for group in groups:
            previous = group[-1]
            gap = bar.centre_y - previous.centre_y
            if (
                gap <= MAX_LINE_GAP_RATIO * max(bar.height, previous.height)
                and _x_overlap(bar, previous) >= MIN_X_OVERLAP
            ):
                group.append(bar)
                break
        else:
            groups.append([bar])

    return groups


def _score(group: list[_Bar]) -> float:
    """Ranks candidate blocks; a two- or three-line block is the expected shape.

    TD3 passports have two MRZ lines and TD1 identity cards have three, so a
    group of that size is far more likely to be the MRZ than a lone bar that
    happens to be elongated.
    """
    shape_bonus = 2.0 if 2 <= len(group) <= 3 else 1.0
    return shape_bonus * sum(bar.width * bar.height for bar in group)


def locate_mrz(image: np.ndarray) -> np.ndarray | None:
    """Finds the MRZ block and returns it deskewed, or None if not found."""
    mask = _text_mask(image)
    if mask is None:
        return None

    page_height, page_width = image.shape[:2]
    bars = _candidate_bars(mask, page_height, page_width)
    if not bars:
        return None

    best = max(_group_bars(bars), key=_score)

    # One rotated rectangle spanning every bar in the winning group.
    points = np.vstack([cv2.boxPoints(cv2.minAreaRect(bar.contour)) for bar in best])
    return _deskew(image, cv2.minAreaRect(points.astype(np.float32)))


def _deskew(image: np.ndarray, rect) -> np.ndarray:
    """Warps a rotated rectangle to an axis-aligned crop, with a small margin."""
    (centre_x, centre_y), (width, height), angle = rect
    if width < height:
        width, height = height, width
        angle += 90.0

    # A few percent of padding keeps the outermost glyph stems inside the crop.
    width = width * 1.04
    height = height * 1.25

    matrix = cv2.getRotationMatrix2D((centre_x, centre_y), angle, 1.0)
    rotated = cv2.warpAffine(
        image,
        matrix,
        (image.shape[1], image.shape[0]),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )
    return cv2.getRectSubPix(rotated, (int(width), int(height)), (centre_x, centre_y))


def _fallback_strip(image: np.ndarray) -> np.ndarray:
    """Bottom quarter of the page, used when localisation finds nothing.

    Crude, but a surprising number of otherwise unreadable photos are simply
    tight crops of the MRZ itself, where there is no surrounding document for
    the morphological pass to separate it from.
    """
    height = image.shape[0]
    return image[int(height * 0.72) : height, :]


def _upscale(grey: np.ndarray) -> np.ndarray:
    """Enlarges a strip until the glyphs clear Tesseract's comfortable range."""
    height = grey.shape[0]
    if height >= TARGET_STRIP_HEIGHT:
        return grey
    scale = TARGET_STRIP_HEIGHT / height
    return cv2.resize(grey, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def _variants(strip: np.ndarray, prefix: str) -> list[Candidate]:
    """Several binarisations of one strip.

    Glare, coloured security printing under the MRZ, and shadows each defeat a
    different thresholding strategy, so we run several at once.
    """
    grey = _upscale(cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY))

    # Order matters now that the caller stops early: the sooner a quorum of
    # complete readings is reached, the fewer Tesseract calls are made. Plain
    # Otsu is the strongest general performer on a high-contrast strip and goes
    # first; unthresholded grey is the weakest and goes last, as a long shot for
    # strips the thresholds ruin. This ordering is a heuristic and worth
    # revisiting against the per-variant timings the sidecar now reports.
    out: list[Candidate] = []

    _, otsu = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    out.append(Candidate(f"{prefix}:otsu", otsu))

    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(grey)
    _, clahe_otsu = cv2.threshold(clahe, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    out.append(Candidate(f"{prefix}:clahe-otsu", clahe_otsu))

    # Sharpened before thresholding, for strips that were small in the original
    # photograph and are soft after upscaling.
    _, sharp_otsu = cv2.threshold(sharpen(grey), 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    out.append(Candidate(f"{prefix}:sharp-otsu", sharp_otsu))

    adaptive = cv2.adaptiveThreshold(
        grey, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11
    )
    out.append(Candidate(f"{prefix}:adaptive", adaptive))

    out.append(Candidate(f"{prefix}:grey", grey))

    return out


def sharpen(grey: np.ndarray) -> np.ndarray:
    """Unsharp mask.

    The MRZ on a phone photograph is often only a few dozen pixels tall, and
    upscaling a soft image adds no detail on its own. Subtracting a blurred
    copy restores edge contrast between adjacent glyphs, which is what
    separates `<` from `K` when the strokes have bled together.
    """
    blurred = cv2.GaussianBlur(grey, (0, 0), sigmaX=3)
    return cv2.addWeighted(grey, 1.6, blurred, -0.6, 0)


# A band shorter than this is speckle, not a line of text.
MIN_LINE_HEIGHT = 6
# Rows carrying less ink than this share of the busiest row count as blank.
INK_THRESHOLD = 0.12


def split_lines(binary: np.ndarray) -> list[np.ndarray]:
    """Splits a binarised MRZ strip into its individual lines.

    Tesseract reads a single line of fixed-pitch text considerably better than
    a block of them, because it stops trying to infer layout and cannot let one
    line's baseline estimate distort another's. A horizontal projection is
    enough to find the split: MRZ lines are separated by a band of clean
    background, and nothing else in the crop competes.
    """
    if binary.ndim != 2 or binary.shape[0] < MIN_LINE_HEIGHT * 2:
        return []

    ink_per_row = (binary < 128).sum(axis=1)
    if ink_per_row.max() == 0:
        return []

    occupied = ink_per_row > ink_per_row.max() * INK_THRESHOLD

    bands: list[tuple[int, int]] = []
    start: int | None = None
    for row, has_ink in enumerate(occupied):
        if has_ink and start is None:
            start = row
        elif not has_ink and start is not None:
            if row - start >= MIN_LINE_HEIGHT:
                bands.append((start, row))
            start = None
    if start is not None and len(occupied) - start >= MIN_LINE_HEIGHT:
        bands.append((start, len(occupied)))

    height = binary.shape[0]
    # A couple of rows of margin: cropping tight to the ink clips descenders
    # and the tops of digits.
    return [binary[max(0, top - 2) : min(height, bottom + 2), :] for top, bottom in bands]


def build_candidates(image: np.ndarray) -> list[Candidate]:
    """Produces every rendering worth running OCR against, best guess first."""
    working = _to_working_size(image)
    candidates: list[Candidate] = []

    located = locate_mrz(working)
    if located is not None and located.size > 0:
        candidates.extend(_variants(located, "located"))

    candidates.extend(_variants(_fallback_strip(working), "bottom"))
    return candidates

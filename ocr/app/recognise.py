"""Tesseract invocation, constrained to the MRZ alphabet.

Restricting the character set to `A-Z0-9<` is the single highest-value setting
here: it removes every lowercase letter and punctuation mark from the search
space, which eliminates a whole class of misreads before they happen.
"""

from __future__ import annotations

import os
import re
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pytesseract

MRZ_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"

# `mrz` is trained on OCR-B passport zones. It matters more than it sounds: the
# `eng` model has no chevron in its training data and so cannot emit `<` at
# all, substituting K/E/S/C instead. Since a name field is mostly filler, that
# destroys names while leaving digits intact.
#
# The Docker image installs it. A native development machine may not have it,
# so `eng` plus the character whitelist remains the fallback — degraded, not
# broken. `/health` reports which model was actually loaded.
PREFERRED_LANG = os.environ.get("TESSERACT_LANG", "mrz")
FALLBACK_LANG = "eng"

# PSM 6: a single uniform block of text. The MRZ is exactly that, and it stops
# Tesseract from trying to infer a page layout that does not exist.
TESSERACT_CONFIG = (
    f"--oem 1 --psm 6 -c tessedit_char_whitelist={MRZ_ALPHABET} "
    "-c load_system_dawg=0 -c load_freq_dawg=0"
)

# PSM 7: one line, treated as one line. Given a single row of fixed-pitch
# glyphs Tesseract stops inferring layout altogether and cannot let one line's
# baseline estimate distort its neighbour's, which is worth a noticeable amount
# of accuracy on a small or skewed strip.
TESSERACT_LINE_CONFIG = (
    f"--oem 1 --psm 7 -c tessedit_char_whitelist={MRZ_ALPHABET} "
    "-c load_system_dawg=0 -c load_freq_dawg=0"
)

_LINE_NOISE = re.compile(r"[^A-Z0-9<]")


@dataclass(frozen=True)
class Recognition:
    variant: str
    text: str
    lines: list[str]


def _available_lang() -> str:
    try:
        if PREFERRED_LANG in pytesseract.get_languages(config=""):
            return PREFERRED_LANG
    except Exception:  # noqa: BLE001 - a probe failure must not break OCR
        pass
    return FALLBACK_LANG


_LANG = _available_lang()


def language() -> str:
    """The Tesseract model actually in use; surfaced on /health for ops."""
    return _LANG


def _clean(line: str) -> str:
    """Normalises one OCR line to the MRZ alphabet.

    Spaces are mapped to the filler character rather than deleted: Tesseract
    frequently reads a run of `<<<` as whitespace, and dropping it would
    shorten the line below 44 characters and lose positional alignment.
    """
    return _LINE_NOISE.sub("", line.upper().replace(" ", "<"))


def recognise(variant: str, image: np.ndarray) -> Recognition:
    raw = pytesseract.image_to_string(image, lang=_LANG, config=TESSERACT_CONFIG)
    lines = [cleaned for line in raw.splitlines() if (cleaned := _clean(line))]
    return Recognition(variant=variant, text="\n".join(lines), lines=lines)


# Line lengths of the layouts the caller decodes: TD3 is 2x44, TD1 is 3x30.
_COMPLETE_SHAPES = ((44, 2), (30, 3))


def looks_complete(lines: Sequence[str]) -> bool:
    """Whether a reading has the *shape* of a full MRZ.

    Deliberately only a shape test — no check digits, no field semantics. Those
    live on the caller's side and stay there; duplicating them here is how the
    two implementations would drift apart.

    Its only job is to decide when enough readings have been gathered to stop
    calling Tesseract. Being wrong costs time, never correctness: a reading
    that passes here still has to survive validation and the consensus vote
    upstream.
    """
    for length, needed in _COMPLETE_SHAPES:
        if sum(1 for line in lines if len(line) == length) >= needed:
            return True
    return False


def recognise_lines(variant: str, images: Sequence[np.ndarray]) -> Recognition:
    """Recognises each MRZ line separately, one Tesseract call per line.

    Costs one extra call per line over reading the block in one go, and buys
    accuracy on exactly the inputs that need it. The results join the same
    candidate pool as every other variant, so a per-line reading has to win the
    same votes as anything else — it is extra evidence, not a shortcut.
    """
    lines: list[str] = []
    for image in images:
        raw = pytesseract.image_to_string(image, lang=_LANG, config=TESSERACT_LINE_CONFIG)
        for line in raw.splitlines():
            cleaned = _clean(line)
            if cleaned:
                lines.append(cleaned)

    return Recognition(variant=variant, text="\n".join(lines), lines=lines)

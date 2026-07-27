"""Tesseract invocation, constrained to the MRZ alphabet.

Restricting the character set to `A-Z0-9<` is the single highest-value setting
here: it removes every lowercase letter and punctuation mark from the search
space, which eliminates a whole class of misreads before they happen.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

import numpy as np
import pytesseract

MRZ_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"

# `mrz` is a community-trained model specialised for OCR-B passport zones. It
# is a meaningful accuracy win but is not packaged by Debian, so the image may
# ship without it; `eng` plus the whitelist is a serviceable fallback.
PREFERRED_LANG = os.environ.get("TESSERACT_LANG", "mrz")
FALLBACK_LANG = "eng"

# PSM 6: a single uniform block of text. The MRZ is exactly that, and it stops
# Tesseract from trying to infer a page layout that does not exist.
TESSERACT_CONFIG = (
    f"--oem 1 --psm 6 -c tessedit_char_whitelist={MRZ_ALPHABET} "
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

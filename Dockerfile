# syntax=docker/dockerfile:1.7

# Single image, two processes: the Node bot and the Python OCR sidecar. They
# talk over loopback, so the container is the security boundary and no OCR port
# is ever published.

# ---------- Stage 1: compile TypeScript ----------
FROM node:22-bookworm-slim AS node-build

WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


# ---------- Stage 2: Python dependencies ----------
# Built on the *same* base as the runtime stage on purpose. A virtualenv is
# bound to the exact interpreter that created it. Building it on
# python:3.12-slim and copying it into an image whose `python3` is Debian's
# 3.11 produces a venv whose symlinks and site-packages path point at an
# interpreter that isn't there. The image builds green and then fails to start.
FROM node:22-bookworm-slim AS python-build

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Debian's python3.11 seeds a venv with setuptools 66.1.1, which carries
# CVE-2024-6345 and CVE-2025-47273. Upgrading the seed packages is the fix;
# they are build-time tooling and nothing here imports them at runtime.
RUN pip install --no-cache-dir --upgrade pip setuptools

# Keep this list in sync with ocr/pyproject.toml, which is authoritative.
RUN pip install --no-cache-dir \
      "fastapi>=0.115" "uvicorn[standard]>=0.34" "pydantic>=2.10" \
      "opencv-python-headless>=4.11" "numpy>=2.1" "pytesseract>=0.3.13"


# ---------- Stage 3: the MRZ recognition model ----------
# Tesseract's `eng` model has no OCR-B chevron in its training data, so it
# cannot emit `<` and substitutes K/E/S/C instead. Since an MRZ name field is
# mostly filler, that destroys names while leaving digits intact, which is the
# failure this addresses.
#
# Pinned to a commit and verified by digest: the build fails rather than
# installs a different file if upstream ever changes. Fetched in its own stage
# so curl never reaches the runtime image.
FROM debian:bookworm-slim AS tessdata

ARG MRZ_COMMIT=1e7adfecda5f3c9ae1fb12cf6b4b8c3958c63e46
ARG MRZ_SHA256=e44f5b7a6bdd3f382ef3bfa84ee0057f5897946a84a094c26910e0a124f3a9bd

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL \
      "https://raw.githubusercontent.com/DoubangoTelecom/tesseractMRZ/${MRZ_COMMIT}/tessdata_best/mrz.traineddata" \
      -o /tmp/mrz.traineddata \
 && echo "${MRZ_SHA256}  /tmp/mrz.traineddata" | sha256sum -c -


# ---------- Stage 4: runtime ----------
FROM node:22-bookworm-slim AS runtime

# tesseract-ocr provides the engine; libglib2.0-0 is the one native library the
# headless OpenCV wheel still links against. tini reaps the two child processes
# so signals and zombies are handled properly.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        tesseract-ocr \
        tesseract-ocr-eng \
        libglib2.0-0 \
        tini \
    && rm -rf /var/lib/apt/lists/*

# The OCR-B model, into Debian's tessdata directory. `recognise.py` probes for
# `mrz` and falls back to `eng` if it is absent, so a wrong path here degrades
# accuracy rather than breaking recognition. Check the `tesseract_lang` field
# on /health to confirm which model is actually loaded.
COPY --from=tessdata /tmp/mrz.traineddata /usr/share/tesseract-ocr/5/tessdata/mrz.traineddata

# Strip the package managers the base image ships. The container's only job is
# `node dist/index.js` and `uvicorn`. npm, npx, corepack and yarn are never
# invoked at runtime, but their bundled dependencies (tar, brace-expansion,
# picomatch, sigstore) carry HIGH/CRITICAL CVEs that the vulnerability gate
# rightly refuses to let through. Removing them is a real reduction in attack
# surface, not a suppression: a package manager inside a production image is a
# convenient way for an attacker with code execution to fetch a payload.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=python-build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY --from=node-build /build/node_modules ./node_modules
COPY --from=node-build /build/dist ./dist
COPY package.json ./
COPY ocr/app ./ocr/app
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Unprivileged user. `node` (uid 1000) already exists in the base image.
USER node

# Baked in so a running container can report which commit it is. Without this
# a stale image is indistinguishable from a broken fix, which has already cost
# one round of misdiagnosis. Pass with
# `docker build --build-arg BUILD_COMMIT=$(git rev-parse HEAD)`.
ARG BUILD_COMMIT=unknown

ENV NODE_ENV=production \
    BUILD_COMMIT=${BUILD_COMMIT} \
    OCR_SIDECAR_URL=http://127.0.0.1:8000 \
    PYTHONPATH=/app \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]

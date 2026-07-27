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
# bound to the exact interpreter that created it — building it on
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


# ---------- Stage 3: runtime ----------
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

# Optional accuracy upgrade: a traineddata model specialised for OCR-B passport
# zones. It is not packaged by Debian, so it is not installed here — drop the
# file into /usr/share/tesseract-ocr/5/tessdata/mrz.traineddata and the sidecar
# picks it up automatically (see ocr/app/recognise.py). Without it the code
# falls back to `eng` with the MRZ character whitelist.

# Strip the package managers the base image ships. The container's only job is
# `node dist/index.js` and `uvicorn` — npm, npx, corepack and yarn are never
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

ENV NODE_ENV=production \
    OCR_SIDECAR_URL=http://127.0.0.1:8000 \
    PYTHONPATH=/app \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]

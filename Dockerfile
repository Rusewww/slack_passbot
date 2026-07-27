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
FROM python:3.12-slim-bookworm AS python-build

WORKDIR /build
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY ocr/pyproject.toml ./
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
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]

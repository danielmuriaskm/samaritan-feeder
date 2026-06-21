# Samaritan CV sidecar.
# Build arg DETECTOR selects which backend deps to bake in:
#   rfdetr (default, Apache-2.0, CPU torch) | onnx (lean, no torch) | none
#
#   docker build --build-arg DETECTOR=rfdetr -t samaritan-cv ./cv-sidecar
#   docker build --build-arg DETECTOR=onnx   -t samaritan-cv ./cv-sidecar
FROM python:3.11-slim AS base

ARG DETECTOR=rfdetr
# WITH_CLIP=true installs open_clip for semantic search (requires torch, which the
# rfdetr/ultralytics detectors already pull in).
ARG WITH_CLIP=false
ENV CV_DETECTOR=${DETECTOR} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# opencv-python-headless still needs a couple of shared libs at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt requirements-rfdetr.txt requirements-clip.txt ./
RUN pip install -r requirements.txt \
    && if [ "$DETECTOR" = "rfdetr" ]; then \
         pip install --extra-index-url https://download.pytorch.org/whl/cpu \
           torch==2.5.1 torchvision==0.20.1 \
         && pip install -r requirements-rfdetr.txt ; \
       elif [ "$DETECTOR" = "ultralytics" ]; then \
         pip install --extra-index-url https://download.pytorch.org/whl/cpu \
           torch==2.5.1 torchvision==0.20.1 ultralytics==8.3.40 ; \
       fi \
    && if [ "$WITH_CLIP" = "true" ]; then \
         if [ "$DETECTOR" != "rfdetr" ] && [ "$DETECTOR" != "ultralytics" ]; then \
           pip install --extra-index-url https://download.pytorch.org/whl/cpu torch==2.5.1 ; \
         fi; \
         pip install -r requirements-clip.txt ; \
       fi

COPY app ./app
COPY smoke_test.py ./

EXPOSE 8800
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8800/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8800"]

"""Samaritan CV sidecar — FastAPI service.

Owns ALL pixel handling for the feeder. Accepts a frame, runs license-clean
object detection via supervision, and returns ONLY anonymous aggregates
(per-class counts, crowd density, zone occupancy). Never returns identities,
tracks, or free-text descriptions.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .config import settings
from . import analyze as analyze_mod
from . import clip as clip_mod

# Hard cap on concurrent clip analyses — clip decode + multi-frame inference is
# CPU-bound and would otherwise oversubscribe the (throttled) vCPUs.
_clip_sem = threading.BoundedSemaphore(settings.MAX_CONCURRENT_CLIPS)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("cv-sidecar")

# Pin onnxruntime/OpenMP thread budget to allocated vCPUs.
os.environ.setdefault("OMP_NUM_THREADS", str(settings.THREADS))

SUPERVISION_VERSION = "unknown"
try:
    import supervision as _sv

    SUPERVISION_VERSION = getattr(_sv, "__version__", "unknown")
except Exception:  # pragma: no cover
    pass

_state: dict = {"backend": None}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    from .detector import load_backend

    log.info("Loading detector backend: %s", settings.DETECTOR)
    t0 = time.time()
    _state["backend"] = load_backend()
    log.info(
        "Detector ready: name=%s loaded=%s (%.1fs)",
        _state["backend"].name,
        _state["backend"].loaded,
        time.time() - t0,
    )
    # Loud audit of any enabled biometric capability.
    for flag in ("ALLOW_FACE_RECOGNITION", "ALLOW_PLATE_OCR", "ALLOW_PERSON_REID", "ALLOW_CROSS_CAMERA_TRACKING"):
        if getattr(settings, flag):
            log.warning("PRIVACY: %s is ENABLED — this is a deliberate, audited opt-in.", flag)
    yield
    _state["backend"] = None


app = FastAPI(title="Samaritan CV Sidecar", version="0.1.0", lifespan=lifespan)


def _check_auth(authorization: str | None) -> None:
    if not settings.AUTH_TOKEN:
        return
    expected = f"Bearer {settings.AUTH_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


class ZoneSpec(BaseModel):
    id: str
    polygon: list[list[float]] = Field(..., description="fractional [[x,y],...] in 0..1")
    name: str | None = None
    dwell_threshold_sec: float | None = None
    object_classes: list[str] | None = None


class LineSpec(BaseModel):
    id: str
    start: list[float] = Field(..., description="fractional [x,y] in 0..1")
    end: list[float] = Field(..., description="fractional [x,y] in 0..1")
    name: str | None = None


class AnalyzeRequest(BaseModel):
    source_id: str
    frame_base64: str
    region: str = "unknown"  # 'EU' | 'non_EU' | 'unknown'
    detect_classes: list[str] | None = None
    zones: list[ZoneSpec] | None = None
    want_thumbnail: bool = False


class SpeedSpec(BaseModel):
    image_points: list[list[float]]  # 4 fractional [x,y]
    world_points: list[list[float]]  # 4 real-world [X,Y] metres
    max_kmh: float | None = None
    expected_heading_deg: float | None = None


class AnalyzeClipRequest(BaseModel):
    source_id: str
    clip_url: str
    region: str = "unknown"
    sampled_fps: float = 6.0
    max_seconds: float = 4.0
    clip_start_ms: int | None = None
    detect_classes: list[str] | None = None
    zones: list[ZoneSpec] | None = None
    lines: list[LineSpec] | None = None
    want_artifact: bool = False
    want_embedding: bool = False
    speed: SpeedSpec | None = None


class ValidateConfigRequest(BaseModel):
    zones: list[ZoneSpec] | None = None
    lines: list[LineSpec] | None = None
    watch_classes: list[str] | None = None


class EmbedTextRequest(BaseModel):
    text: str


@app.get("/health")
def health() -> dict:
    backend = _state.get("backend")
    return {
        "status": "ok",
        "model_loaded": bool(backend and backend.loaded),
        "detector": backend.name if backend else None,
        "supervision": SUPERVISION_VERSION,
    }


@app.get("/version")
def version() -> dict:
    backend = _state.get("backend")
    licenses = {
        "rfdetr": "Apache-2.0",
        "onnx": "model-dependent (operator-supplied)",
        "ultralytics": "AGPL-3.0",
        "yolo-world": "GPL/AGPL (copyleft)",
        "yoloworld": "GPL/AGPL (copyleft)",
        "openvocab": "GPL/AGPL (copyleft)",
        "none": "n/a",
    }
    copyleft = settings.DETECTOR in ("ultralytics", "yolo-world", "yoloworld", "openvocab")
    return {
        "supervision": SUPERVISION_VERSION,
        "detector": settings.DETECTOR,
        "model": backend.name if backend else None,
        "model_license": licenses.get(settings.DETECTOR, "unknown"),
        "copyleft": copyleft,
        "redact_before_return": settings.REDACT_BEFORE_RETURN,
        "semantic_search": {"enabled": settings.CLIP_ENABLED, "model": settings.CLIP_MODEL, "dim": settings.CLIP_DIM},
        "biometrics_enabled": {
            "face_recognition": settings.ALLOW_FACE_RECOGNITION,
            "plate_ocr": settings.ALLOW_PLATE_OCR,
            "person_reid": settings.ALLOW_PERSON_REID,
            "cross_camera_tracking": settings.ALLOW_CROSS_CAMERA_TRACKING,
        },
    }


@app.post("/v1/analyze")
def analyze(req: AnalyzeRequest, authorization: str | None = Header(default=None)) -> dict:
    _check_auth(authorization)
    backend = _state.get("backend")
    if backend is None:
        raise HTTPException(status_code=503, detail="detector not ready")

    t0 = time.time()
    try:
        image = analyze_mod.decode_frame(req.frame_base64)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    result = analyze_mod.analyze_frame(
        image,
        backend,
        detect_classes=req.detect_classes,
        zones=[z.model_dump() for z in (req.zones or [])],
        want_thumbnail=req.want_thumbnail,
    )
    result["ms"] = int((time.time() - t0) * 1000)
    return result


@app.post("/v1/analyze-clip")
def analyze_clip(req: AnalyzeClipRequest, authorization: str | None = Header(default=None)) -> dict:
    _check_auth(authorization)
    backend = _state.get("backend")
    if backend is None:
        raise HTTPException(status_code=503, detail="detector not ready")

    if not _clip_sem.acquire(blocking=True, timeout=2.0):
        raise HTTPException(status_code=503, detail="sidecar at clip-analysis capacity, retry later")

    t0 = time.time()
    try:
        result = clip_mod.analyze_clip(
            req.clip_url,
            backend,
            source_id=req.source_id,
            sampled_fps=req.sampled_fps,
            max_seconds=req.max_seconds,
            clip_start_ms=req.clip_start_ms if req.clip_start_ms is not None else int(time.time() * 1000),
            detect_classes=req.detect_classes,
            zones=[z.model_dump() for z in (req.zones or [])],
            lines=[ln.model_dump() for ln in (req.lines or [])],
            want_artifact=req.want_artifact,
            want_embedding=req.want_embedding,
            speed=req.speed.model_dump() if req.speed else None,
        )
    except clip_mod.ClipError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    finally:
        _clip_sem.release()

    result["ms"] = int((time.time() - t0) * 1000)
    return result


@app.post("/v1/embed-text")
def embed_text_route(req: EmbedTextRequest, authorization: str | None = Header(default=None)) -> dict:
    """Embed a query string into the shared CLIP space (for semantic search)."""
    _check_auth(authorization)
    from . import embed as embed_mod

    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty query")
    if not embed_mod.available():
        raise HTTPException(status_code=503, detail="semantic search disabled (CV_CLIP_ENABLED=false or open_clip missing)")
    vec = embed_mod.embed_text(text[:512])
    if vec is None:
        raise HTTPException(status_code=503, detail="CLIP model unavailable")
    return {"embedding": vec, "dim": len(vec)}


@app.post("/v1/validate-config")
def validate_config(req: ValidateConfigRequest) -> dict:
    errors: list[str] = []

    def _check_pt(p, where: str) -> None:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            errors.append(f"{where}: point must be [x, y]")
            return
        for v in p:
            if not isinstance(v, (int, float)) or not (0.0 <= float(v) <= 1.0):
                errors.append(f"{where}: coords must be fractional 0..1, got {v}")

    for z in req.zones or []:
        if len(z.polygon) < 3:
            errors.append(f"zone {z.id}: polygon needs >= 3 points")
        for i, p in enumerate(z.polygon):
            _check_pt(p, f"zone {z.id} point {i}")
    for ln in req.lines or []:
        _check_pt(ln.start, f"line {ln.id} start")
        _check_pt(ln.end, f"line {ln.id} end")

    return {"valid": not errors, "errors": errors}

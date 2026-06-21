"""Single-frame analysis pipeline built on supervision.

Pure function over a decoded BGR frame -> anonymous aggregate result. No
identity, no tracking, no free-text. Optionally returns a REDACTED (pixelated)
thumbnail for downstream LLM enrichment.
"""

from __future__ import annotations

import base64
from collections import Counter

import cv2
import numpy as np
import supervision as sv

from .config import settings
from . import coco


def decode_frame(frame_base64: str) -> np.ndarray:
    raw = base64.b64decode(frame_base64)
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode frame (not a valid JPEG/PNG)")
    return img


def _class_names(detections: sv.Detections) -> list[str]:
    data_names = detections.data.get("class_name") if detections.data else None
    # Only trust data['class_name'] if it is length-aligned with the detections
    # (defends against a backend returning a mismatched array after slicing).
    if data_names is not None and len(data_names) == len(detections):
        return [str(n) for n in data_names]
    if detections.class_id is None:
        return []
    return [coco.COCO91.get(int(c), f"class_{int(c)}") for c in detections.class_id]


def _crowd_density(person_count: int) -> str:
    light, moderate, busy, crowded = settings.CROWD_THRESHOLDS
    if person_count < light:
        return "empty"
    if person_count < moderate:
        return "light"
    if person_count < busy:
        return "moderate"
    if person_count < crowded:
        return "busy"
    return "crowded"


def _activity_level(total: int) -> str:
    if total < 3:
        return "low"
    if total <= 10:
        return "medium"
    return "high"


def _scale_polygon(polygon_fractional: list[list[float]], w: int, h: int) -> np.ndarray:
    pts = np.array(polygon_fractional, dtype=np.float32)
    pts[:, 0] *= w
    pts[:, 1] *= h
    return pts.astype(np.int32)


def _pixelate_whole(image_bgr: np.ndarray) -> np.ndarray:
    """Coarsely pixelate an entire frame (fail-closed fallback)."""
    h, w = image_bgr.shape[:2]
    k = max(8, settings.PIXELATE_SIZE)
    small = cv2.resize(image_bgr, (max(1, w // k), max(1, h // k)), interpolation=cv2.INTER_LINEAR)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)


def _redact(image_bgr: np.ndarray, detections: sv.Detections, names: list[str]) -> np.ndarray:
    """Irreversibly pixelate persons. FAIL-CLOSED: if no person box is found (a
    person may still be present below the detection threshold), pixelate the
    WHOLE frame rather than return identifiable pixels. So a returned frame has
    ALWAYS had pixels masked — `redaction_applied=True` is therefore truthful.
    """
    if len(detections):
        mask = np.array([n in coco.REDACT_CLASSES for n in names], dtype=bool)
        if mask.any():
            annotator = sv.PixelateAnnotator(pixel_size=settings.PIXELATE_SIZE)
            return annotator.annotate(scene=image_bgr.copy(), detections=detections[mask])
    return _pixelate_whole(image_bgr)


def analyze_frame(
    image_bgr: np.ndarray,
    backend,
    *,
    detect_classes: list[str] | None,
    zones: list[dict] | None,
    want_thumbnail: bool,
) -> dict:
    h, w = image_bgr.shape[:2]
    detections = backend.detect(image_bgr)
    names = _class_names(detections)

    # Filter to the requested classes (default: people + vehicles).
    watch = set(detect_classes or coco.DEFAULT_WATCH_CLASSES)
    if len(detections) and watch:
        keep = np.array([n in watch for n in names], dtype=bool)
        detections = detections[keep]
        names = [n for n, k in zip(names, keep) if k]

    counts = Counter(names)
    person_count = counts.get("person", 0)
    total = int(len(detections))

    zone_results = []
    for z in zones or []:
        try:
            polygon = _scale_polygon(z["polygon"], w, h)
            zone = sv.PolygonZone(polygon=polygon)
            inside = zone.trigger(detections=detections)
            zone_results.append({"id": str(z.get("id", "")), "occupancy": int(inside.sum())})
        except Exception:
            zone_results.append({"id": str(z.get("id", "")), "occupancy": 0})

    crowd = _crowd_density(person_count)
    anomaly_reasons = []
    if person_count >= settings.CROWD_ANOMALY_THRESHOLD:
        anomaly_reasons.append("crowd")

    result = {
        "ok": True,
        "counts": {str(k): int(v) for k, v in counts.items()},
        "peak_person": person_count,
        "crowd_density": crowd,
        "zones": zone_results,
        "lines": [],  # P1 (requires a clip / tracking)
        "anomaly": {"detected": bool(anomaly_reasons), "reasons": anomaly_reasons},
        "scene": {"activity_level": _activity_level(total)},
        "frames_analyzed": 1,
        "model": backend.name,
        "redaction_applied": False,
    }

    if want_thumbnail:
        thumb = image_bgr
        if settings.REDACT_BEFORE_RETURN:
            thumb = _redact(image_bgr, detections, names)
            result["redaction_applied"] = True
        ok, buf = cv2.imencode(".jpg", thumb, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if ok:
            result["thumbnail_base64"] = base64.b64encode(buf.tobytes()).decode("ascii")

    return result

"""Sidecar runtime configuration, read from the environment.

Privacy-relevant flags default to the SAFE value (redaction on, all biometric
capabilities off). Enabling a forbidden capability requires an explicit,
case-sensitive opt-in and is logged loudly at startup.
"""

from __future__ import annotations

import os


def _flag(name: str, default: bool) -> bool:
    """Strict boolean: only true/1/yes/on (any case) means True.

    Unlike a permissive coercion, the string "false" is NOT truthy — important
    so that an operator who writes ALLOW_FACE_RECOGNITION=false cannot
    accidentally enable it.
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("true", "1", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


class Settings:
    # Detector selection: rfdetr (Apache-2.0, default) | onnx | ultralytics | none
    DETECTOR: str = os.getenv("CV_DETECTOR", os.getenv("CV_MODEL", "rfdetr")).strip().lower()
    # Path to a YOLO-format .onnx model when DETECTOR=onnx
    ONNX_PATH: str = os.getenv("CV_ONNX_PATH", "/models/detector.onnx")
    # RF-DETR variant: nano | small | medium (nano is the CPU-friendly default)
    RFDETR_VARIANT: str = os.getenv("CV_RFDETR_VARIANT", "nano").strip().lower()
    # Inference square resolution. RF-DETR requires a multiple of 56 (default 560);
    # 448/336 trade accuracy for CPU latency. YOLO ONNX typically uses 640.
    RESOLUTION: int = _int("CV_RESOLUTION", 0)  # 0 = backend default

    # Detection thresholds
    MIN_SCORE: float = _float("CV_MIN_SCORE", 0.35)

    # Crowd-density bucketing on the person count
    CROWD_THRESHOLDS: tuple[int, int, int, int] = (1, 4, 11, 26)  # light/moderate/busy/crowded
    # Person count at or above which a frame is flagged as a crowd anomaly
    CROWD_ANOMALY_THRESHOLD: int = _int("CV_CROWD_THRESHOLD", 25)

    # Privacy guards (ON-by-default / OFF-by-default biometrics)
    REDACT_BEFORE_RETURN: bool = _flag("VISION_REDACT_BEFORE_STORE", True)
    ALLOW_FACE_RECOGNITION: bool = _flag("ALLOW_FACE_RECOGNITION", False)
    ALLOW_PLATE_OCR: bool = _flag("ALLOW_PLATE_OCR", False)
    ALLOW_PERSON_REID: bool = _flag("ALLOW_PERSON_REID", False)
    ALLOW_CROSS_CAMERA_TRACKING: bool = _flag("ALLOW_CROSS_CAMERA_TRACKING", False)

    # CPU thread budget (set to allocated vCPUs, e.g. Fly shared-cpu-2x -> 2)
    THREADS: int = _int("CV_THREADS", 2)

    # ----- Clip / tracking (P1) -----
    # Hard cap on concurrent clip analyses (CPU bound). Defaults to vCPUs.
    MAX_CONCURRENT_CLIPS: int = _int("CV_MAX_CONCURRENT_CLIPS", _int("CV_THREADS", 2))
    # Decode caps so one feed can't peg CPU or run unbounded.
    CLIP_MAX_SECONDS: float = _float("CV_CLIP_MAX_SECONDS", 6.0)
    CLIP_MAX_FRAMES: int = _int("CV_CLIP_MAX_FRAMES", 48)
    # A track must be seen >= this many frames to be confirmed (debounce).
    CONFIRM_FRAMES: int = _int("CV_CONFIRM_FRAMES", 2)
    # ByteTrack tuning. lost_track_buffer is in FRAMES — at low sampled fps the
    # default (30) expires tracks ~5x too fast, so scale it to the sampled rate.
    TRACK_ACTIVATION_THRESHOLD: float = _float("CV_TRACK_ACTIVATION_THRESHOLD", 0.5)
    LOST_TRACK_BUFFER: int = _int("CV_LOST_TRACK_BUFFER", 0)  # 0 = derive from fps
    # How many seconds before the DECODE phase is abandoned.
    CLIP_READ_TIMEOUT_SEC: float = _float("CV_CLIP_READ_TIMEOUT_SEC", 8.0)
    # Total wall-clock budget for decode + inference combined. Keep strictly
    # below the Node CV_SIDECAR_TIMEOUT_MS (25s) so the sidecar returns partial
    # aggregates and releases its concurrency slot before Node aborts.
    CLIP_PROCESS_TIMEOUT_SEC: float = _float("CV_CLIP_PROCESS_TIMEOUT_SEC", 18.0)

    # Shared bearer token for Node<->sidecar auth on the internal network.
    AUTH_TOKEN: str = os.getenv("CV_SIDECAR_TOKEN", "")

    PIXELATE_SIZE: int = _int("CV_PIXELATE_SIZE", 20)

    # ----- Semantic search (P2 deferred) — CLIP embeddings of REDACTED frames -----
    CLIP_ENABLED: bool = _flag("CV_CLIP_ENABLED", False)
    CLIP_MODEL: str = os.getenv("CV_CLIP_MODEL", "ViT-B-32")
    CLIP_PRETRAINED: str = os.getenv("CV_CLIP_PRETRAINED", "laion2b_s34b_b79k")
    CLIP_DIM: int = _int("CV_CLIP_DIM", 512)


settings = Settings()

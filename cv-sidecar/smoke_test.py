"""Offline smoke test: verifies every supervision signature the sidecar relies on
against the pinned version, and runs the analysis pipeline on a synthetic frame
with the Null backend (no model weights required).

    python smoke_test.py

Exits non-zero on any signature drift so CI catches it before deploy.
"""

from __future__ import annotations

import base64
import sys

import cv2
import numpy as np
import supervision as sv

from app import analyze as analyze_mod
from app.detector import NullBackend


def check_supervision_api() -> list[str]:
    errors: list[str] = []

    # Detections construction + filtering + empty
    try:
        d = sv.Detections(
            xyxy=np.array([[0, 0, 10, 10]], dtype=np.float32),
            confidence=np.array([0.9], dtype=np.float32),
            class_id=np.array([0]),
        )
        d.data["class_name"] = np.array(["person"], dtype=object)
        _ = d[np.array([True])]
        _ = sv.Detections.empty()
        assert len(d) == 1
    except Exception as exc:
        errors.append(f"sv.Detections core: {exc!r}")

    # PolygonZone.trigger -> bool mask
    try:
        zone = sv.PolygonZone(polygon=np.array([[0, 0], [100, 0], [100, 100], [0, 100]]))
        mask = zone.trigger(detections=d)
        assert mask.dtype == bool
    except Exception as exc:
        errors.append(f"sv.PolygonZone: {exc!r}")

    # PixelateAnnotator.annotate
    try:
        scene = np.zeros((120, 120, 3), dtype=np.uint8)
        out = sv.PixelateAnnotator(pixel_size=10).annotate(scene=scene.copy(), detections=d)
        assert out.shape == scene.shape
    except Exception as exc:
        errors.append(f"sv.PixelateAnnotator: {exc!r}")

    # with_nms exists (used by the onnx backend)
    try:
        _ = d.with_nms(threshold=0.5)
    except Exception as exc:
        errors.append(f"sv.Detections.with_nms: {exc!r}")

    # P1: LineZone + Point (in/out crossing counts)
    try:
        line = sv.LineZone(start=sv.Point(0, 50), end=sv.Point(100, 50))
        dt = sv.Detections(
            xyxy=np.array([[10, 10, 20, 20]], dtype=np.float32),
            confidence=np.array([0.9], dtype=np.float32),
            class_id=np.array([0]),
        )
        dt.tracker_id = np.array([1])
        line.trigger(dt)
        assert isinstance(line.in_count, int) and isinstance(line.out_count, int)
    except Exception as exc:
        errors.append(f"sv.LineZone/Point: {exc!r}")

    # P1: a tracker is available (trackers pkg or sv.ByteTrack fallback)
    try:
        from app.tracking import make_tracker

        tracker = make_tracker(frame_rate=6)
        out = tracker.update(sv.Detections.empty())
        assert isinstance(out, sv.Detections)
    except Exception as exc:
        errors.append(f"tracker.update: {exc!r}")

    return errors


def check_pipeline() -> list[str]:
    errors: list[str] = []
    try:
        frame = np.full((240, 320, 3), 127, dtype=np.uint8)
        ok, buf = cv2.imencode(".jpg", frame)
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")
        img = analyze_mod.decode_frame(b64)
        result = analyze_mod.analyze_frame(
            img,
            NullBackend(),
            detect_classes=None,
            zones=[{"id": "z1", "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]]}],
            want_thumbnail=True,
        )
        for key in ("ok", "counts", "crowd_density", "zones", "anomaly", "scene", "frames_analyzed"):
            assert key in result, f"missing key {key}"
        assert result["counts"] == {}, "Null backend should yield no counts"
        assert result["crowd_density"] == "empty"
    except Exception as exc:
        errors.append(f"pipeline: {exc!r}")
    return errors


def check_clip_pipeline() -> list[str]:
    """Best-effort: write a tiny mp4 and run the clip pipeline with the Null
    backend. Skips (no error) if a video codec is unavailable in this env."""
    import os
    import tempfile

    from app import clip as clip_mod
    from app.detector import NullBackend

    errors: list[str] = []
    path = os.path.join(tempfile.gettempdir(), "cv_smoke.mp4")
    try:
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 6, (160, 120))
        if not writer.isOpened():
            print("clip pipeline: skipped (no mp4 writer)")
            return errors
        for _ in range(12):
            writer.write(np.full((120, 160, 3), 100, dtype=np.uint8))
        writer.release()

        result = clip_mod.analyze_clip(
            path,
            NullBackend(),
            source_id="s1",
            sampled_fps=6,
            max_seconds=2,
            clip_start_ms=0,
            detect_classes=None,
            zones=[{"id": "z1", "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]]}],
            lines=[{"id": "L1", "start": [0, 0.5], "end": [1, 0.5]}],
        )
        for key in ("tracks", "zones", "lines", "clip_meta", "counts"):
            assert key in result, f"missing {key}"
        assert result["tracks"] == [], "Null backend should yield no tracks"
        assert result["lines"][0]["in"] == 0
    except Exception as exc:
        errors.append(f"clip pipeline: {exc!r}")
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return errors


def check_speed() -> list[str]:
    errors: list[str] = []
    try:
        from app.speed import make_speed_estimator, heading_deviation

        # 1px == 1m mapping on a 100x100 frame; move 10m over 1s -> 36 km/h.
        est = make_speed_estimator(
            [[0, 0], [1, 0], [1, 1], [0, 1]],
            [[0, 0], [100, 0], [100, 100], [0, 100]],
            (100, 100),
        )
        assert est is not None
        out = est((10, 50), (20, 50), 1.0)
        assert out is not None and abs(out["speed_kmh"] - 36.0) < 1.0, out
        assert abs(heading_deviation(0, 200) - 160) < 0.01
        # malformed calibration -> no estimator
        assert make_speed_estimator([[0, 0]], [[0, 0]], (100, 100)) is None
    except Exception as exc:
        errors.append(f"speed: {exc!r}")
    return errors


def main() -> int:
    print(f"supervision == {getattr(sv, '__version__', '?')}")
    errors = check_supervision_api() + check_pipeline() + check_clip_pipeline() + check_speed()
    if errors:
        print("SMOKE TEST FAILED:")
        for e in errors:
            print("  -", e)
        return 1
    print("smoke test OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

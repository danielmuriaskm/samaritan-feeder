"""Clip acquisition + multi-frame analysis (detect -> track -> zones/lines/dwell
-> consolidate). Returns ONLY anonymous aggregates and consolidated tracks.

The sidecar fetches and decodes the clip itself from `clip_url`, keeping frame
bytes off the Node event loop entirely. Decode is hard-capped by frames and
wall-clock so one feed can't peg the CPU.
"""

from __future__ import annotations

import base64
import time
from collections import Counter

import cv2
import numpy as np
import supervision as sv

from .config import settings
from . import coco
from .analyze import _class_names, _crowd_density, _activity_level, _scale_polygon, _redact
from .tracking import make_tracker, TrackAggregator
from .speed import make_speed_estimator, heading_deviation


class ClipError(RuntimeError):
    pass


def acquire_frames(clip_url: str, sampled_fps_req: float, max_seconds: float) -> tuple[list[np.ndarray], float]:
    """Decode a short clip into a list of frames sampled at ~sampled_fps_req.

    Returns (frames, effective_sampled_fps). Bounded by CLIP_MAX_FRAMES,
    max_seconds, and CLIP_READ_TIMEOUT_SEC.
    """
    cap = cv2.VideoCapture(clip_url)
    if not cap.isOpened():
        raise ClipError(f"could not open clip source")

    src_fps = cap.get(cv2.CAP_PROP_FPS)
    if not src_fps or src_fps != src_fps or src_fps <= 0:  # 0 / NaN
        src_fps = 15.0
    stride = max(1, int(round(src_fps / max(1.0, sampled_fps_req))))
    effective_fps = src_fps / stride

    max_seconds = min(max_seconds, settings.CLIP_MAX_SECONDS)
    max_read = int(src_fps * max_seconds)
    deadline = time.time() + settings.CLIP_READ_TIMEOUT_SEC

    frames: list[np.ndarray] = []
    read = 0
    try:
        while read < max_read and len(frames) < settings.CLIP_MAX_FRAMES:
            if time.time() > deadline:
                break
            ok, frame = cap.read()
            if not ok:
                break
            if read % stride == 0:
                frames.append(frame)
            read += 1
    finally:
        cap.release()

    return frames, effective_fps


def analyze_clip(
    clip_url: str,
    backend,
    *,
    source_id: str,
    sampled_fps: float,
    max_seconds: float,
    clip_start_ms: int,
    detect_classes: list[str] | None,
    zones: list[dict] | None,
    lines: list[dict] | None,
    want_artifact: bool = False,
    want_embedding: bool = False,
    speed: dict | None = None,
) -> dict:
    # Single wall-clock budget spanning BOTH decode and inference, kept below the
    # Node abort so we always return partial aggregates and free the slot in time.
    process_deadline = time.time() + settings.CLIP_PROCESS_TIMEOUT_SEC

    frames, fps = acquire_frames(clip_url, sampled_fps, max_seconds)
    if not frames:
        raise ClipError("no frames decoded from clip source")

    h, w = frames[0].shape[:2]
    watch = set(detect_classes or coco.DEFAULT_WATCH_CLASSES)
    tracker = make_tracker(fps)
    id_to_name = getattr(backend, "id_to_name", {}) or {}
    speed_estimator = None
    if speed:
        speed_estimator = make_speed_estimator(speed.get("image_points"), speed.get("world_points"), (w, h))
    agg = TrackAggregator(source_id, clip_start_ms, fps, (w, h), speed_estimator=speed_estimator)

    # Build zones / lines (fractional -> pixel).
    zone_objs = []
    for z in zones or []:
        try:
            zone = sv.PolygonZone(polygon=_scale_polygon(z["polygon"], w, h))
            zone_objs.append((str(z.get("id", "")), z.get("name"), zone, z.get("dwell_threshold_sec")))
        except Exception:
            continue
    line_objs = []
    for ln in lines or []:
        try:
            sx, sy = ln["start"]
            ex, ey = ln["end"]
            line = sv.LineZone(
                start=sv.Point(int(sx * w), int(sy * h)),
                end=sv.Point(int(ex * w), int(ey * h)),
            )
            line_objs.append((str(ln.get("id", "")), ln.get("name"), line))
        except Exception:
            continue

    peak_person = 0
    zone_peak: dict[str, int] = {zid: 0 for zid, _, _, _ in zone_objs}
    zone_class_at_peak: dict[str, Counter] = {zid: Counter() for zid, _, _, _ in zone_objs}
    zone_dwell_seen: dict[str, float] = {zid: 0.0 for zid, _, _, _ in zone_objs}
    # Best frame (most detections) for an optional REDACTED alert artifact.
    best_frame_img = None
    best_det = None
    best_names: list[str] = []
    best_count = -1

    processed = 0
    for idx, frame in enumerate(frames):
        if time.time() > process_deadline:
            break  # return partial aggregates rather than blow the Node timeout
        # The ENTIRE per-frame body is guarded: one bad frame (decode artdefact,
        # tracker/zone edge case) must never 500 the whole clip — we skip it.
        try:
            det = backend.detect(frame)
            processed += 1
            names = _class_names(det)
            if len(det) and watch:
                keep = np.array([n in watch for n in names], dtype=bool)
                det = det[keep]
            det = tracker.update(det)
            # Drop unmatched detections (ByteTrackTracker assigns tracker_id == -1)
            # so zones/lines/aggregator all see one consistent, real-track set.
            if det.tracker_id is not None and len(det):
                det = det[det.tracker_id >= 0]
            names = _class_names(det)

            zone_hits: dict[str, np.ndarray] = {}
            for zid, _zname, zone, _dwell in zone_objs:
                mask = zone.trigger(det)
                zone_hits[zid] = mask
                occ = int(mask.sum())
                if occ > zone_peak[zid]:
                    zone_peak[zid] = occ
                    zone_class_at_peak[zid] = Counter(n for n, k in zip(names, mask) if k)

            for _lid, _lname, line in line_objs:
                line.trigger(det)

            agg.observe(idx, det, names, zone_hits)
            peak_person = max(peak_person, sum(1 for n in names if n == "person"))

            if want_artifact and len(det) > best_count:
                best_count = len(det)
                best_frame_img = frame
                best_det = det
                best_names = names
        except Exception:
            continue

    tracks = agg.consolidate()

    # Optional REDACTED best-frame artifact + CLIP embedding. Both derive from
    # the SAME redacted frame (persons pixelated) — never raw imagery.
    artifact_b64 = None
    embedding = None
    redacted_done = False
    if (want_artifact or want_embedding) and best_frame_img is not None and settings.REDACT_BEFORE_RETURN:
        redacted = _redact(best_frame_img, best_det, best_names)
        redacted_done = True
        if want_artifact:
            ok, buf = cv2.imencode(".jpg", redacted, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            if ok:
                artifact_b64 = base64.b64encode(buf.tobytes()).decode("ascii")
        if want_embedding:
            from .embed import embed_image_bgr

            embedding = embed_image_bgr(redacted)

    # Update per-zone max dwell from confirmed tracks (for loitering rule).
    for t in tracks:
        for zid in t["zones_entered"]:
            if zid in zone_dwell_seen:
                zone_dwell_seen[zid] = max(zone_dwell_seen[zid], t["max_dwell_sec"])

    # counts = distinct confirmed tracks per class (clip throughput).
    counts = Counter(t["label"] for t in tracks)
    dwell_max = max((t["max_dwell_sec"] for t in tracks), default=0.0)

    zones_out = []
    for zid, zname, _zone, dwell_thresh in zone_objs:
        zones_out.append(
            {
                "id": zid,
                "name": zname,
                "peak_occupancy": zone_peak[zid],
                "class_counts": dict(zone_class_at_peak[zid]),
            }
        )
    lines_out = []
    for lid, lname, line in line_objs:
        per_class = {}
        try:
            in_pc = getattr(line, "in_count_per_class", {}) or {}
            out_pc = getattr(line, "out_count_per_class", {}) or {}
            # Decode class_id via the BACKEND's own id->name map (COCO80 vs COCO91
            # differ); fall back to COCO91 only if the backend exposes none.
            name_of = (lambda cid: id_to_name.get(int(cid), coco.COCO91.get(int(cid), str(cid))))
            for cid, c in in_pc.items():
                per_class.setdefault(name_of(cid), {"in": 0, "out": 0})["in"] = int(c)
            for cid, c in out_pc.items():
                per_class.setdefault(name_of(cid), {"in": 0, "out": 0})["out"] = int(c)
        except Exception:
            per_class = {}
        lines_out.append(
            {"id": lid, "name": lname, "in": int(line.in_count), "out": int(line.out_count), "per_class": per_class}
        )

    # Anomaly rules.
    reasons: list[str] = []
    if peak_person >= settings.CROWD_ANOMALY_THRESHOLD:
        reasons.append("crowd")
    for zid, _zname, _zone, dwell_thresh in zone_objs:
        if dwell_thresh and zone_dwell_seen.get(zid, 0.0) >= float(dwell_thresh):
            reasons.append("loitering")
            break
    if speed:
        max_kmh = speed.get("max_kmh")
        expected = speed.get("expected_heading_deg")
        if max_kmh and any(t.get("speed_kmh", 0) > float(max_kmh) for t in tracks):
            reasons.append("overspeed")
        if expected is not None and any(
            "heading_deg" in t and heading_deviation(t["heading_deg"], float(expected)) > 90.0 for t in tracks
        ):
            reasons.append("wrong_way")

    return {
        "ok": True,
        "clip_meta": {"fps": round(fps, 2), "frames": len(frames), "duration_sec": round(len(frames) / max(1.0, fps), 2)},
        "counts": {str(k): int(v) for k, v in counts.items()},
        "peak_person": peak_person,
        "crowd_density": _crowd_density(peak_person),
        "zones": zones_out,
        "lines": lines_out,
        "tracks": tracks,
        "dwellMaxSec": round(dwell_max, 2),
        "anomaly": {"detected": bool(reasons), "reasons": reasons},
        "scene": {"activity_level": _activity_level(len(tracks))},
        "frames_analyzed": processed,
        "model": backend.name,
        "redaction_applied": redacted_done,
        **({"artifact_base64": artifact_b64} if artifact_b64 else {}),
        **({"embedding": embedding} if embedding else {}),
    }

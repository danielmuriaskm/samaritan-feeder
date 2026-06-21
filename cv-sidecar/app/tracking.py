"""Transient multi-object tracking and per-clip track consolidation.

A fresh tracker is created PER CLIP and discarded when the clip is done. The raw
`tracker_id` never leaves this module: consolidated tracks are keyed by an opaque
hash (`track_key`). No appearance, embedding, or cross-camera identity exists.

Tracker backend: roboflow `trackers` (Apache-2.0) `ByteTrackTracker`, falling
back to the in-library `sv.ByteTrack` if `trackers` is unavailable.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field

import numpy as np
import supervision as sv

from .config import settings

log = logging.getLogger("cv-sidecar.tracking")


def make_tracker(frame_rate: float):
    """Create a per-clip tracker. Prefers the Apache-2.0 `trackers` package.

    frame_rate is the SAMPLED clip fps (by design) — both the tracker's internal
    timing and lost_track_buffer are derived from it, so they stay consistent.
    """
    frame_rate = max(1.0, float(frame_rate))
    lost_buffer = settings.LOST_TRACK_BUFFER or max(8, int(round(frame_rate * 2)))
    try:
        from trackers import ByteTrackTracker  # type: ignore

        tracker = ByteTrackTracker(
            frame_rate=frame_rate,
            lost_track_buffer=lost_buffer,
            minimum_consecutive_frames=settings.CONFIRM_FRAMES,
            track_activation_threshold=settings.TRACK_ACTIVATION_THRESHOLD,
        )
        return _TrackersAdapter(tracker)
    except Exception as exc:  # pragma: no cover - depends on optional dep
        log.info("trackers package unavailable (%s); using sv.ByteTrack fallback", exc)
        bt = sv.ByteTrack(
            frame_rate=frame_rate,
            lost_track_buffer=lost_buffer,
            minimum_consecutive_frames=settings.CONFIRM_FRAMES,
            track_activation_threshold=settings.TRACK_ACTIVATION_THRESHOLD,
        )
        return _SvByteTrackAdapter(bt)


class _TrackersAdapter:
    def __init__(self, tracker) -> None:
        self._t = tracker

    def update(self, detections: sv.Detections) -> sv.Detections:
        return self._t.update(detections)


class _SvByteTrackAdapter:
    def __init__(self, tracker) -> None:
        self._t = tracker

    def update(self, detections: sv.Detections) -> sv.Detections:
        return self._t.update_with_detections(detections)


@dataclass
class _TrackState:
    label: str
    top_score: float
    frames_seen: int = 0
    first_frame: int = 0
    last_frame: int = 0
    first_centroid: tuple[float, float] = (0.0, 0.0)
    last_centroid: tuple[float, float] = (0.0, 0.0)
    zones_entered: set[str] = field(default_factory=set)
    edge_touched: bool = False


class TrackAggregator:
    """Accumulates per-tracker stats across the frames of one clip, then emits
    consolidated, anonymous track records (Frigate "one record per track")."""

    def __init__(self, source_id: str, clip_start_ms: int, sampled_fps: float, frame_wh: tuple[int, int], speed_estimator=None) -> None:
        self._source_id = source_id
        self._clip_start_ms = clip_start_ms
        self._fps = max(1.0, sampled_fps)
        self._w, self._h = frame_wh
        self._states: dict[int, _TrackState] = {}
        self._speed_estimator = speed_estimator

    def observe(self, frame_idx: int, detections: sv.Detections, names: list[str], zone_hits: dict[str, np.ndarray]) -> None:
        if detections.tracker_id is None:
            return
        edge_margin_x = 0.03 * self._w
        edge_margin_y = 0.03 * self._h
        for i, tid in enumerate(detections.tracker_id):
            tid = int(tid)
            if tid < 0:
                continue  # unmatched detection (ByteTrackTracker emits -1) — not a track
            x1, y1, x2, y2 = detections.xyxy[i]
            cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
            label = names[i] if i < len(names) else "object"
            score = float(detections.confidence[i]) if detections.confidence is not None else 0.0

            st = self._states.get(tid)
            if st is None:
                st = _TrackState(label=label, top_score=score, first_frame=frame_idx, first_centroid=(cx, cy))
                self._states[tid] = st
            st.frames_seen += 1
            st.last_frame = frame_idx
            st.top_score = max(st.top_score, score)
            st.last_centroid = (cx, cy)
            if (x1 <= edge_margin_x or y1 <= edge_margin_y or x2 >= self._w - edge_margin_x or y2 >= self._h - edge_margin_y):
                st.edge_touched = True
            for zone_id, mask in zone_hits.items():
                if i < len(mask) and bool(mask[i]):
                    st.zones_entered.add(zone_id)

    def consolidate(self) -> list[dict]:
        out: list[dict] = []
        for tid, st in self._states.items():
            if st.frames_seen < settings.CONFIRM_FRAMES:
                continue  # debounce flickers
            dwell = (st.last_frame - st.first_frame) / self._fps
            track_key = hashlib.sha1(
                f"{self._source_id}:{self._clip_start_ms}:{tid}".encode()
            ).hexdigest()[:12]
            # Coarse 10x10 spatial bucket of the last centroid. Returned as a
            # strict "BXxBY" token (not a free string) — Node composes the full
            # cross-clip dedupe key from this + already-allowlisted fields, so the
            # sidecar has no free-text channel into the DB.
            bx = int(st.last_centroid[0] / max(1.0, self._w) * 10)
            by = int(st.last_centroid[1] / max(1.0, self._h) * 10)
            track = {
                "track_key": track_key,
                "label": st.label,
                "top_score": round(st.top_score, 3),
                "frames_seen": st.frames_seen,
                "first_seen_ms": self._clip_start_ms + int(st.first_frame / self._fps * 1000),
                "last_seen_ms": self._clip_start_ms + int(st.last_frame / self._fps * 1000),
                "max_dwell_sec": round(dwell, 2),
                "zones_entered": sorted(st.zones_entered),
                "edge_touched": st.edge_touched,
                "bbox_bucket": f"{bx}x{by}",
            }
            if self._speed_estimator is not None and dwell > 0:
                sp = self._speed_estimator(st.first_centroid, st.last_centroid, dwell)
                if sp:
                    track.update(sp)  # adds speed_kmh, heading_deg
            out.append(track)
        return out

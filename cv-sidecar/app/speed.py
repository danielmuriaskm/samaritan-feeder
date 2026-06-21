"""Speed / heading estimation via a 4-point homography (image px -> world metres).

Operator supplies four image points (fractional 0..1) and their real-world metre
coordinates. We map a track's first/last centroid into world space and divide by
elapsed time. Produces only aggregate speed_kmh / heading_deg per track — no
position trail is exposed.
"""

from __future__ import annotations

import math

import cv2
import numpy as np


class ViewTransformer:
    def __init__(self, source_px: list, target_world: list) -> None:
        self._m = cv2.getPerspectiveTransform(
            np.array(source_px, dtype=np.float32),
            np.array(target_world, dtype=np.float32),
        )

    def transform(self, pts: list) -> np.ndarray:
        a = np.array(pts, dtype=np.float32).reshape(-1, 1, 2)
        out = cv2.perspectiveTransform(a, self._m)
        return out.reshape(-1, 2)


def make_speed_estimator(image_points_frac: list, world_points: list, frame_wh: tuple[int, int]):
    """Returns est(first_px, last_px, dt_sec) -> {speed_kmh, heading_deg} | None.

    Returns None (no estimator) if the calibration is malformed.
    """
    if not image_points_frac or not world_points or len(image_points_frac) != 4 or len(world_points) != 4:
        return None
    w, h = frame_wh
    src = [[float(p[0]) * w, float(p[1]) * h] for p in image_points_frac]
    try:
        vt = ViewTransformer(src, world_points)
    except Exception:
        return None

    def est(first_px, last_px, dt_sec):
        if dt_sec <= 0:
            return None
        wp = vt.transform([list(first_px), list(last_px)])
        (x0, y0), (x1, y1) = wp[0], wp[1]
        dist_m = math.hypot(x1 - x0, y1 - y0)
        return {
            "speed_kmh": round(dist_m / dt_sec * 3.6, 1),
            "heading_deg": round(math.degrees(math.atan2(y1 - y0, x1 - x0)), 1),
        }

    return est


def heading_deviation(heading_deg: float, expected_deg: float) -> float:
    """Smallest absolute angle (0..180) between a heading and the expected heading."""
    d = abs((heading_deg - expected_deg + 180.0) % 360.0 - 180.0)
    return d

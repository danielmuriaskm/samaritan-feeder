# Samaritan CV Sidecar

A small, CPU-only Python service that does the **pixel work** for the feeder:
object detection on camera frames via [roboflow/supervision](https://github.com/roboflow/supervision),
returning **only anonymous aggregates** (per-class counts, crowd density, zone
occupancy). It never returns identities, tracks, or free-text descriptions.

The Node feeder calls this over HTTP instead of base64-ing frames to a vision
LLM. Detection is cheaper, more precise, and keeps raw imagery out of the
feeder's database entirely.

## Why a separate service?

supervision is Python; the feeder is Node/TypeScript. A sidecar also lets us
**contain the detector's license**: the default detector is **RF-DETR (Apache-2.0)**,
fully compatible with the MIT feeder. Ultralytics YOLO (AGPL-3.0) is available
only as an explicit, warned opt-in and is never shipped by default.

## Endpoints

| Method | Path                  | Purpose                                                            |
|--------|-----------------------|-------------------------------------------------------------------|
| GET    | `/health`             | Liveness + whether a model is loaded                              |
| GET    | `/version`            | Pinned versions, detector, **model license**, biometric flag state |
| POST   | `/v1/analyze`         | Single frame → counts, crowd density, zone occupancy (P0)         |
| POST   | `/v1/analyze-clip`    | Short clip → ByteTrack + line in/out + zone occupancy + dwell + consolidated tracks (P1) |
| POST   | `/v1/validate-config` | Validate per-source zones/lines geometry (P1)                    |

`/v1/analyze-clip` fetches and decodes the clip itself from `clip_url`
(`sampled_fps`, `max_seconds` bounded), runs a **transient** per-clip
`ByteTrackTracker`, and returns anonymous aggregates plus a `tracks[]` array
keyed by an opaque `track_key` — the raw `tracker_id` never leaves the process.
Concurrent clip analyses are capped by `CV_MAX_CONCURRENT_CLIPS` (default =
vCPUs) since decode + multi-frame inference is CPU-bound.

`POST /v1/analyze` request:

```json
{
  "source_id": "cam_madrid_01",
  "frame_base64": "<jpeg bytes>",
  "region": "EU",
  "detect_classes": ["person", "car", "bus", "truck"],
  "zones": [{ "id": "crosswalk", "polygon": [[0.1,0.4],[0.9,0.4],[0.9,0.8],[0.1,0.8]] }],
  "want_thumbnail": false
}
```

Response (aggregates only):

```json
{
  "ok": true,
  "counts": { "person": 3, "car": 1 },
  "crowd_density": "light",
  "zones": [{ "id": "crosswalk", "occupancy": 2 }],
  "lines": [],
  "anomaly": { "detected": false, "reasons": [] },
  "scene": { "activity_level": "medium" },
  "frames_analyzed": 1,
  "model": "rf-detr-nano",
  "redaction_applied": false,
  "ms": 180
}
```

## Detector selection (`CV_DETECTOR`)

| Value         | Model            | License                    | Notes                                  |
|---------------|------------------|----------------------------|----------------------------------------|
| `rfdetr`      | RF-DETR (Nano)   | **Apache-2.0** (default)   | Auto-downloads weights; CPU torch      |
| `onnx`        | YOLO-format ONNX | model-dependent            | No torch; set `CV_ONNX_PATH`           |
| `ultralytics` | YOLOv8/11        | **AGPL-3.0** (opt-in)      | Loud warning; not shipped by default   |
| `none`        | —                | n/a                        | Runs the service with zero detections  |

If the chosen backend's deps/weights are missing, the service **falls back to
`none`** and logs why, rather than crashing — so the pipeline is always testable.

## Build

```bash
# default: license-clean RF-DETR (larger image, CPU torch)
docker build -t samaritan-cv ./cv-sidecar

# lean image, no torch — bring your own YOLO-format .onnx
docker build --build-arg DETECTOR=onnx -t samaritan-cv ./cv-sidecar
```

## Smoke test

`python smoke_test.py` verifies every supervision signature the sidecar uses
against the pinned version (`supervision==0.29.0`) and runs the pipeline on a
synthetic frame with the `none` backend — no model weights required. Wire it
into CI to catch supervision API drift before deploy.

## Privacy

- Persons (and any configured PII classes) are **irreversibly pixelated**
  (`PixelateAnnotator`) before any thumbnail leaves the service, when
  `VISION_REDACT_BEFORE_STORE=true` (default).
- `ALLOW_FACE_RECOGNITION`, `ALLOW_PLATE_OCR`, `ALLOW_PERSON_REID`,
  `ALLOW_CROSS_CAMERA_TRACKING` all default **false** and require a strict,
  case-sensitive opt-in. Any enabled flag is logged loudly at startup.
- No tracking and no identity in P0. Per-clip tracking (P1) keeps `tracker_id`
  in-process only — it never crosses the HTTP boundary.

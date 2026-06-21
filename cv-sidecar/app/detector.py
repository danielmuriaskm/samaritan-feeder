"""Pluggable object-detection backends, all returning `supervision.Detections`.

Backends:
  - rfdetr       RF-DETR (Apache-2.0). License-clean default. Auto-downloads weights.
  - onnx         Operator-supplied YOLO-format .onnx via onnxruntime (no torch).
  - ultralytics  Opt-in only. AGPL-3.0 — emits a loud warning. Not shipped by default.
  - none         No model loaded; returns empty detections so the service still
                 runs end-to-end (health reports model_loaded=false).

The selected backend is resolved once at startup. If the chosen backend's deps
or weights are unavailable, we fall back to `none` and log why, rather than
crashing the service.
"""

from __future__ import annotations

import logging
import os
from typing import Protocol

import numpy as np
import supervision as sv

from .config import settings
from . import coco

log = logging.getLogger("cv-sidecar.detector")


class Backend(Protocol):
    name: str
    loaded: bool

    def detect(self, image_bgr: np.ndarray) -> sv.Detections:
        ...


def _names_from(detections: sv.Detections, id_to_name) -> sv.Detections:
    """Ensure detections.data['class_name'] is populated."""
    if detections.class_id is None:
        return detections
    existing = detections.data.get("class_name") if detections.data else None
    if existing is not None and len(existing) == len(detections):
        return detections
    names = np.array(
        [id_to_name.get(int(cid), f"class_{int(cid)}") for cid in detections.class_id],
        dtype=object,
    )
    detections.data["class_name"] = names
    return detections


class NullBackend:
    name = "none"
    loaded = False
    id_to_name: dict = {}

    def detect(self, image_bgr: np.ndarray) -> sv.Detections:
        return sv.Detections.empty()


class RFDetrBackend:
    """RF-DETR (Apache-2.0). `model.predict()` returns sv.Detections directly."""

    name = "rfdetr"

    def __init__(self) -> None:
        from rfdetr import RFDETRNano, RFDETRSmall, RFDETRMedium  # type: ignore

        variant = {
            "nano": RFDETRNano,
            "small": RFDETRSmall,
            "medium": RFDETRMedium,
        }.get(settings.RFDETR_VARIANT, RFDETRNano)

        kwargs = {}
        if settings.RESOLUTION:
            kwargs["resolution"] = settings.RESOLUTION
        self._model = variant(**kwargs)
        # Warm up / fuse for inference if the API supports it.
        if hasattr(self._model, "optimize_for_inference"):
            try:
                self._model.optimize_for_inference()
            except Exception as exc:  # pragma: no cover - best effort
                log.warning("optimize_for_inference failed: %s", exc)

        try:
            from rfdetr.util.coco_classes import COCO_CLASSES  # type: ignore

            self._id_to_name = dict(COCO_CLASSES)
        except Exception:
            self._id_to_name = dict(coco.COCO91)
        self.id_to_name = self._id_to_name
        self.loaded = True
        self.name = f"rf-detr-{settings.RFDETR_VARIANT}"

    def detect(self, image_bgr: np.ndarray) -> sv.Detections:
        # RF-DETR expects RGB. ascontiguousarray avoids a negative-stride view
        # (torch.from_numpy rejects negative strides).
        rgb = np.ascontiguousarray(image_bgr[:, :, ::-1])
        detections = self._model.predict(rgb, threshold=settings.MIN_SCORE)
        return _names_from(detections, self._id_to_name)


class OnnxYoloBackend:
    """YOLOv8/YOLO11-format ONNX via onnxruntime. No torch dependency.

    NOTE: a YOLO .onnx export still carries the upstream model's license
    (Ultralytics YOLO weights are AGPL-3.0). Supplying one here is an explicit
    operator decision; the default shipped image does not include such weights.
    """

    name = "onnx"

    def __init__(self) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = settings.THREADS
        opts.inter_op_num_threads = max(1, settings.THREADS // 2)
        self._sess = ort.InferenceSession(
            settings.ONNX_PATH, sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self._input = self._sess.get_inputs()[0]
        shape = self._input.shape
        self._imgsz = settings.RESOLUTION or (int(shape[2]) if isinstance(shape[2], int) else 640)
        self._id_to_name = {i: n for i, n in enumerate(coco.COCO80)}
        self.id_to_name = self._id_to_name
        self.loaded = True

    def detect(self, image_bgr: np.ndarray) -> sv.Detections:
        import cv2

        h0, w0 = image_bgr.shape[:2]
        imgsz = self._imgsz
        # letterbox-free simple resize (square) + scale-back
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (imgsz, imgsz))
        blob = resized.astype(np.float32) / 255.0
        blob = np.transpose(blob, (2, 0, 1))[None, ...]  # NCHW
        out = self._sess.run(None, {self._input.name: blob})[0]  # (1, 84, N) yolov8
        preds = np.squeeze(out, 0)
        if preds.shape[0] < preds.shape[1]:
            preds = preds.T  # -> (N, 84)
        boxes_cxcywh = preds[:, :4]
        scores_all = preds[:, 4:]
        class_id = scores_all.argmax(axis=1)
        confidence = scores_all.max(axis=1)
        keep = confidence >= settings.MIN_SCORE
        boxes_cxcywh, class_id, confidence = boxes_cxcywh[keep], class_id[keep], confidence[keep]
        if len(boxes_cxcywh) == 0:
            return sv.Detections.empty()
        # cxcywh (model space) -> xyxy (original image space)
        sx, sy = w0 / imgsz, h0 / imgsz
        cx, cy, w, h = boxes_cxcywh.T
        xyxy = np.stack(
            [(cx - w / 2) * sx, (cy - h / 2) * sy, (cx + w / 2) * sx, (cy + h / 2) * sy], axis=1
        )
        detections = sv.Detections(
            xyxy=xyxy.astype(np.float32),
            confidence=confidence.astype(np.float32),
            class_id=class_id.astype(int),
        )
        detections = detections.with_nms(threshold=0.5)
        return _names_from(detections, self._id_to_name)


class UltralyticsBackend:
    """Opt-in only. Ultralytics YOLO is AGPL-3.0."""

    name = "ultralytics"

    def __init__(self) -> None:
        log.warning(
            "=" * 72 + "\n"
            "  CV_DETECTOR=ultralytics selected. Ultralytics YOLO is AGPL-3.0.\n"
            "  Running it as a network service can impose AGPL source-availability\n"
            "  obligations on the whole deployment. This is an explicit operator\n"
            "  decision and is NOT the default. Use CV_DETECTOR=rfdetr (Apache-2.0)\n"
            "  to stay license-clean.\n" + "=" * 72
        )
        from ultralytics import YOLO  # type: ignore

        self._model = YOLO(os.getenv("CV_ULTRALYTICS_WEIGHTS", "yolo11n.pt"))
        self._imgsz = settings.RESOLUTION or 640
        try:
            self.id_to_name = dict(self._model.names)
        except Exception:
            self.id_to_name = {i: n for i, n in enumerate(coco.COCO80)}
        self.loaded = True

    def detect(self, image_bgr: np.ndarray) -> sv.Detections:
        result = self._model(image_bgr, imgsz=self._imgsz, conf=settings.MIN_SCORE, verbose=False)[0]
        return sv.Detections.from_ultralytics(result)


class YoloWorldBackend:
    """Open-vocabulary detection (analyst-specified watch classes). Opt-in only.

    YOLO-World weights and the Ultralytics runtime are copyleft (GPL/AGPL). This
    is NOT shipped by default and should run in an ISOLATED container so its
    license does not reach the MIT feeder. Classes come from CV_OPENVOCAB_CLASSES.
    """

    name = "yolo-world"

    def __init__(self) -> None:
        log.warning(
            "=" * 72 + "\n"
            "  CV_DETECTOR=yolo-world selected. YOLO-World / Ultralytics runtime is\n"
            "  copyleft (GPL/AGPL). Run this ONLY in an isolated container; it is an\n"
            "  explicit operator decision and is never shipped by default.\n" + "=" * 72
        )
        from ultralytics import YOLOWorld  # type: ignore

        self._model = YOLOWorld(os.getenv("CV_OPENVOCAB_WEIGHTS", "yolov8s-world.pt"))
        classes = [c.strip() for c in os.getenv("CV_OPENVOCAB_CLASSES", "person,car,truck,bus").split(",") if c.strip()]
        self._model.set_classes(classes)
        self.id_to_name = {i: n for i, n in enumerate(classes)}
        self._imgsz = settings.RESOLUTION or 640
        self.loaded = True

    def detect(self, image_bgr: np.ndarray) -> sv.Detections:
        result = self._model(image_bgr, imgsz=self._imgsz, conf=settings.MIN_SCORE, verbose=False)[0]
        return sv.Detections.from_ultralytics(result)


def load_backend() -> Backend:
    choice = settings.DETECTOR
    try:
        if choice == "rfdetr":
            return RFDetrBackend()
        if choice == "onnx":
            return OnnxYoloBackend()
        if choice == "ultralytics":
            return UltralyticsBackend()
        if choice in ("yolo-world", "yoloworld", "openvocab"):
            return YoloWorldBackend()
        if choice == "none":
            log.warning("CV_DETECTOR=none — service will report zero detections.")
            return NullBackend()
        log.warning("Unknown CV_DETECTOR=%r; falling back to 'none'.", choice)
        return NullBackend()
    except Exception as exc:
        log.error(
            "Failed to initialise detector backend %r (%s). Falling back to 'none'. "
            "Install the backend's deps / provide weights to enable real detection.",
            choice,
            exc,
        )
        return NullBackend()

"""CLIP embeddings for semantic search over REDACTED alert frames.

Lazy-loaded (the model is ~350MB and CPU-heavy) and OFF by default. The model is
loaded on first use only when CV_CLIP_ENABLED. Image embeddings are computed ONLY
on already-redacted frames by the caller — this module never sees a raw frame.

License: the open_clip CODE is MIT and torch is BSD — no copyleft reaches the
feeder. The default LAION-2B weights carry a RAIL-style use-restriction license
(permissive for this use, NOT copyleft) — review before redistributing weights.
Image and text share one embedding space, so the same vectors power text->image
search.
"""

from __future__ import annotations

import logging
import threading

import numpy as np

from .config import settings

log = logging.getLogger("cv-sidecar.embed")

_lock = threading.Lock()
_state: dict = {"model": None, "preprocess": None, "tokenizer": None, "loaded": False, "failed": False}


def available() -> bool:
    return settings.CLIP_ENABLED and not _state["failed"]


def _ensure_loaded() -> bool:
    if _state["loaded"]:
        return True
    if _state["failed"] or not settings.CLIP_ENABLED:
        return False
    with _lock:
        if _state["loaded"]:
            return True
        try:
            import open_clip  # type: ignore
            import torch  # noqa: F401

            log.info("Loading CLIP %s / %s ...", settings.CLIP_MODEL, settings.CLIP_PRETRAINED)
            model, _, preprocess = open_clip.create_model_and_transforms(
                settings.CLIP_MODEL, pretrained=settings.CLIP_PRETRAINED
            )
            model.eval()
            _state.update(
                model=model,
                preprocess=preprocess,
                tokenizer=open_clip.get_tokenizer(settings.CLIP_MODEL),
                loaded=True,
            )
            log.info("CLIP ready (dim=%d)", settings.CLIP_DIM)
            return True
        except Exception as exc:
            log.error("CLIP unavailable (%s). Install open_clip_torch to enable semantic search.", exc)
            _state["failed"] = True
            return False


def _normalize(feats) -> list[float]:
    import torch

    feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats[0].detach().cpu().numpy().astype(np.float32).tolist()


def embed_image_bgr(image_bgr: np.ndarray) -> list[float] | None:
    """Embed an ALREADY-REDACTED BGR frame. Returns None if CLIP is unavailable."""
    if not _ensure_loaded():
        return None
    import torch
    from PIL import Image

    rgb = np.ascontiguousarray(image_bgr[:, :, ::-1])
    pil = Image.fromarray(rgb)
    with torch.no_grad():
        tensor = _state["preprocess"](pil).unsqueeze(0)
        feats = _state["model"].encode_image(tensor)
    return _normalize(feats)


def embed_text(text: str) -> list[float] | None:
    if not _ensure_loaded():
        return None
    import torch

    with torch.no_grad():
        tokens = _state["tokenizer"]([text])
        feats = _state["model"].encode_text(tokens)
    return _normalize(feats)

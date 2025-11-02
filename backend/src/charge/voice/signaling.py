"""Helpers for the WebRTC signalling payloads.

The realtime voice manager historically lived inside
``charge.realtime.managers`` which made it difficult to unit test specific
behaviours. Stage channels introduce extra metadata (per-track quality metrics
and speaker states) so a tiny helper module keeps the logic isolated and
testable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping

PRIMARY_TRACK = "audio"
SCREEN_TRACK = "screen"
DEFAULT_STAGE_STATUS = "listener"

# Users can request to speak, be invited by a moderator, or move off the stage
# without leaving the room entirely. These explicit states override the
# implicit role/mute derived state.
EXPLICIT_STAGE_STATUSES = {
    "listener",
    "invited",
    "requesting",
    "backstage",
    "live",
    "muted",
}


@dataclass(slots=True)
class QualityReport:
    """Structured quality metrics forwarded by clients."""

    track: str
    metrics: Dict[str, Any]

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "QualityReport":
        track_raw = payload.get("track")
        track = normalise_track(track_raw)
        metrics = {key: value for key, value in payload.items() if key != "track"}
        return cls(track=track, metrics=metrics)


def normalise_track(track: Any) -> str:
    """Return a safe track identifier understood by the backend."""

    if isinstance(track, str):
        lowered = track.strip().lower()
        if lowered in {PRIMARY_TRACK, SCREEN_TRACK}:
            return lowered
        if lowered:
            return lowered
    return PRIMARY_TRACK


def merge_quality_metrics(
    existing: Mapping[str, Mapping[str, Any]] | None, report: QualityReport
) -> Dict[str, Dict[str, Any]]:
    """Merge the incoming report into the cached quality dictionary."""

    next_state: Dict[str, Dict[str, Any]] = (
        {name: dict(data) for name, data in existing.items()} if existing else {}
    )
    next_state[report.track] = dict(report.metrics)
    return next_state


def compute_stage_status(
    role: str,
    *,
    muted: bool,
    deafened: bool,
    explicit_status: str | None,
) -> str:
    """Return the public stage status for a participant."""

    if explicit_status:
        lowered = explicit_status.strip().lower()
        if lowered in EXPLICIT_STAGE_STATUSES:
            return lowered

    if role != "speaker":
        return DEFAULT_STAGE_STATUS
    if deafened:
        return "backstage"
    if muted:
        return "muted"
    return "live"


def build_signal_envelope(kind: str, payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Normalise outgoing signalling payloads."""

    track = payload.get("track")
    body: Dict[str, Any] = {"kind": kind}
    if "description" in payload:
        body["description"] = payload.get("description")
    if "candidate" in payload:
        body["candidate"] = payload.get("candidate")
    if track is not None:
        body["track"] = normalise_track(track)
    for key, value in payload.items():
        if key in {"description", "candidate", "track"}:
            continue
        body[key] = value
    return body


__all__ = [
    "PRIMARY_TRACK",
    "SCREEN_TRACK",
    "EXPLICIT_STAGE_STATUSES",
    "QualityReport",
    "compute_stage_status",
    "merge_quality_metrics",
    "build_signal_envelope",
]

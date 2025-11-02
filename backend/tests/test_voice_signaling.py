from charge.voice.signaling import (
    QualityReport,
    build_signal_envelope,
    compute_stage_status,
    merge_quality_metrics,
)


def test_compute_stage_status_defaults_to_listener() -> None:
    assert compute_stage_status("listener", muted=False, deafened=False, explicit_status=None) == "listener"


def test_compute_stage_status_for_speaker_variants() -> None:
    assert compute_stage_status("speaker", muted=False, deafened=False, explicit_status=None) == "live"
    assert compute_stage_status("speaker", muted=True, deafened=False, explicit_status=None) == "muted"
    assert compute_stage_status("speaker", muted=False, deafened=True, explicit_status=None) == "backstage"


def test_compute_stage_status_respects_override() -> None:
    assert compute_stage_status(
        "speaker", muted=False, deafened=False, explicit_status="invited"
    ) == "invited"


def test_merge_quality_metrics_merges_tracks() -> None:
    first = QualityReport.from_payload({"track": "audio", "mos": 4.2})
    second = QualityReport.from_payload({"track": "screen", "bitrate": 3200})
    merged = merge_quality_metrics(None, first)
    merged = merge_quality_metrics(merged, second)
    assert merged == {"audio": {"mos": 4.2}, "screen": {"bitrate": 3200}}


def test_build_signal_envelope_includes_track() -> None:
    payload = build_signal_envelope(
        "offer",
        {
            "description": {"type": "offer", "sdp": "v=0"},
            "track": "SCREEN",
            "mid": "1",
        },
    )
    assert payload["kind"] == "offer"
    assert payload["track"] == "screen"
    assert payload["mid"] == "1"
    assert payload["description"] == {"type": "offer", "sdp": "v=0"}

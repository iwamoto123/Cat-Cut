"""OP enabled with no selected highlight must produce real retained video, not blank time."""

import json
import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import step08_composition
from shared.opening import build_op, load_op_patterns, normalize_op_config


KEEP = [{"start_ms": 1000, "end_ms": 6000}, {"start_ms": 9000, "end_ms": 14000}]
CUTS = [
    {"cut_id": "cut_001", "video": {"file_path": "/segments/first.mp4", "start_ms": 0}},
    {"cut_id": "cut_002", "video": {"file_path": "/segments/second.mp4", "start_ms": 0}},
]


def make_op(*, keep=None, cuts=None, words=None, slots=None, title="", enabled=True):
    return build_op(
        {"pattern": "highlight_teaser" if enabled else "none", "title": title, "catch_copy": "", "clips": None},
        load_op_patterns(), slots or [], KEEP if keep is None else keep, CUTS if cuts is None else cuts,
        "/source.mp4", source_words=words,
    )


def test_no_title_no_candidates_uses_short_real_video():
    op = make_op()
    assert op["pattern"] == "highlight_teaser"
    assert op["title"] == ""
    assert op["fallback_reason"] == "no_highlight_candidates"
    assert op["duration_ms"] == 3500
    assert op["highlight_cuts"] == [{
        "file_path": "/segments/first.mp4", "start_ms": 0, "end_ms": 3500,
        "cut_id": "cut_001", "source_start_ms": 1000, "source_end_ms": 4500,
    }]


def test_fallback_starts_on_retained_speech_and_ends_on_complete_word():
    op = make_op(words=[
        {"text": "削除区間", "start_ms": 6500, "end_ms": 8000},
        {"text": "話し始め", "start_ms": 1800, "end_ms": 2600},
        {"text": "続き", "start_ms": 2700, "end_ms": 4800},
        {"text": "次の長い語", "start_ms": 4900, "end_ms": 5800},
    ])
    clip = op["highlight_cuts"][0]
    assert (clip["source_start_ms"], clip["source_end_ms"]) == (1800, 4800)
    assert (clip["start_ms"], clip["end_ms"]) == (800, 3800)
    assert "text" not in clip  # Never undo a user's caption removal with raw STT.


def test_fallback_never_crosses_removed_gaps_even_when_a_word_spans_them():
    op = make_op(words=[{"text": "またがる語", "start_ms": 4000, "end_ms": 10000}])
    clip = op["highlight_cuts"][0]
    assert (clip["source_start_ms"], clip["source_end_ms"]) == (4000, 6000)
    assert op["duration_ms"] == 2000


def test_plain_directive_slot_can_supply_fallback_speech_timing():
    op = make_op(slots=[{"type": "fact", "text": "通常の発話", "source_start_ms": 9200, "source_end_ms": 11200}])
    clip = op["highlight_cuts"][0]
    assert clip["cut_id"] == "cut_002"
    assert (clip["source_start_ms"], clip["source_end_ms"]) == (9200, 11200)


def test_fallback_prefers_usable_clip_over_tiny_leading_fragment():
    keep = [{"start_ms": 1000, "end_ms": 1100}, {"start_ms": 9000, "end_ms": 14000}]
    assert make_op(keep=keep)["highlight_cuts"][0]["cut_id"] == "cut_002"


def test_entire_very_short_video_keeps_real_duration_without_blank_padding():
    op = make_op(keep=[{"start_ms": 1000, "end_ms": 1200}], cuts=CUTS[:1])
    assert op["duration_ms"] == 200
    assert op["highlight_cuts"][0]["source_end_ms"] == 1200


def test_fallback_handles_original_video_when_segment_extraction_was_unavailable():
    cuts = [{"cut_id": "original", "video": {"file_path": "/source.mp4", "start_ms": 1000}}]
    clip = make_op(keep=KEEP[:1], cuts=cuts)["highlight_cuts"][0]
    assert (clip["start_ms"], clip["end_ms"]) == (1000, 4500)


def test_explicit_off_does_not_generate_fallback_even_with_no_retained_media():
    assert normalize_op_config({"pattern": "none"}) is None
    assert make_op(enabled=False) is None
    assert make_op(enabled=False, keep=[], cuts=[]) is None


def test_no_retained_media_can_use_a_meaningful_title_but_cannot_emit_blank_time():
    op = make_op(keep=[], cuts=[], title="編集済みタイトル")
    assert op["pattern"] == "title_card"
    assert op["title"] == "編集済みタイトル"
    with pytest.raises(ValueError, match="OPに使える映像がありません"):
        make_op(keep=[], cuts=[])


def test_malformed_speech_metadata_cannot_break_usable_video_fallback():
    op = make_op(words=[None, {}, {"text": "語", "start_ms": "invalid", "end_ms": 1000}])
    assert op["highlight_cuts"][0]["source_start_ms"] == 1000


@pytest.mark.parametrize("enabled", [True, False])
def test_step08_horizontal_checkbox_intent_preserves_body_offset(tmp_path, enabled):
    proposal = {
        "keep_segments": [{"start_ms": 0, "end_ms": 6000, "text": "操作を確認します"}],
        "stats": {"original_duration_ms": 6000, "reduction_ratio": 0},
    }
    words = [{"text": "操作を", "start_ms": 500, "end_ms": 2400}, {"text": "確認します", "start_ms": 3600, "end_ms": 5500}]
    for name, data in [("proposal.json", proposal), ("stt.json", {"words": words}), ("telop_directives.json", {"slots": [], "op_title": ""})]:
        (tmp_path / name).write_text(json.dumps(data), encoding="utf-8")
    with mock.patch.object(step08_composition, "get_video_metadata", return_value={"video": {"width": 1920, "height": 1080, "rotation": 0}}), \
            mock.patch.object(step08_composition, "_extract_segments"):
        composition = step08_composition.run_step(
            str(tmp_path / "proposal.json"), str(tmp_path / "stt.json"), str(tmp_path / "source.mp4"),
            str(tmp_path / "step08_composition"), op_config={"pattern": "highlight_teaser" if enabled else "none"},
            orientation="horizontal",
        )
    timeline = composition["timeline"]
    assert composition["meta"]["orientation"] == "horizontal"
    assert bool(timeline.get("op")) is enabled
    offset = 1900 if enabled else 0
    assert timeline["cuts"][0]["timeline"]["start_ms"] == offset
    assert timeline["total_duration_ms"] == 6000 + offset
    if enabled:
        assert timeline["op"]["pattern"] == "highlight_teaser"
        assert timeline["op"]["highlight_cuts"][0]["source_start_ms"] == 500

"""フェーズT2(シーン演出決定エンジン・パス3)の決定的ロジック。

LLMを一切呼ばない純関数群のみをここに置く(step06c_direction.py / step08_composition.py の両方から使う)。

役割:
1. スロット分割: 校正済み keep_segments と word timing から、カット区間を
   2〜4秒粒度の「テロップ表示スロット」に機械分割する(タイミングはAIに決めさせない)
2. AI応答の検証: スタイルIDの正規化・highlight_words のフィルタ・
   「元発話に無い内容語が過半」のスロットを元テキストへ戻すフォールバック安全弁
3. directed モードの composition 素材生成: telop_directives.json から
   timeline.cuts[].telop.pages / voice_data.cuts[].telops / timeline.overlays を組み立てる

設計メモ: スロット・チャプター・オーバーレイは元動画の絶対ms(source_*_ms)をアンカーに持つ。
UIでkeep_segmentsが編集(トリム・分割・削除)されてもAIを再実行せずに済むよう、
step08 は毎回「現在のkeep_segments×絶対msアンカー」からカット相対タイミングを再導出する。
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

from shared.budoux_layout import split_pages
from shared.telop_builder import _normalize_kanji_numbers
from shared.telop_types import (
    ANIMATION_IN_TYPES,
    SEMANTIC_TYPES,
    resolve_animation_for_type,
    resolve_sfx_for_type,
    resolve_style_for_type,
    sanitize_semantic_type,
)
from shared.text_cleaning import apply_deterministic_text_cleaning
from shared.textwidth import glyph_length

# ディレクティブが指定できるスタイルID(telop_presets.yaml の演出系プリセット。
# op_brushはOP専用のため除外)。フェーズT2.5-3で明朝系(serif_quote/serif_harsh)を追加
ALLOWED_DIRECTIVE_STYLES = (
    "fact_yellow",
    "neutral_white",
    "neutral_white_pink",
    "emotion_red",
    "question_blue",
    "reply_cyan",
    "special_purple",
    "box_yellow",
    "box_red",
    "cta_yellow",
    "serif_quote",
    "serif_harsh",
)
DEFAULT_DIRECTIVE_STYLE = "fact_yellow"

# スロット分割の粒度(仕様書「2〜4秒粒度」)
MIN_SLOT_MS = 2000
MAX_SLOT_MS = 4000
# この無音ギャップを超えたらスロット境界の候補にする
SLOT_BREAK_GAP_MS = 350
# 上限超過を避けるための強制分割時に許容する最小スロット長
FORCE_BREAK_MIN_MS = 1200

# オーバーレイ種別ごとの既定表示時間(ms)。スロット長の方が長ければスロット長を使う
OVERLAY_DEFAULT_DURATION_MS = {
    "profile_card": 5000,
    "list_stack": 4000,
    "cta_banner": 4000,
}
OVERLAY_DEFAULT_POSITION = {
    "profile_card": "bottom_left",
    "list_stack": "center",
    "cta_banner": "bottom",
}
ALLOWED_OVERLAY_TYPES = tuple(OVERLAY_DEFAULT_DURATION_MS.keys())

_SENTENCE_END_CHARS = set("。！？!?")
_PERIOD_RE = re.compile(r"[。]")


def _clean_slot_text(text: str) -> str:
    """スロットの表示用テキスト整形(決定的クリーニング+「。」除去)。"""
    cleaned = apply_deterministic_text_cleaning(text or "")
    return _PERIOD_RE.sub("", cleaned).strip()


# ---------------------------------------------------------------------------
# 1. スロット分割 (決定的)
# ---------------------------------------------------------------------------

def _words_in_segment(words: List[Dict[str, Any]], seg: Dict[str, Any]) -> List[Dict[str, Any]]:
    return sorted(
        (
            w for w in words
            if int(w.get("end_ms", 0)) > int(seg["start_ms"]) and int(w.get("start_ms", 0)) < int(seg["end_ms"])
        ),
        key=lambda w: int(w.get("start_ms", 0)),
    )


def _split_words_into_runs(seg_words: List[Dict[str, Any]], seg_start_ms: int) -> List[List[Dict[str, Any]]]:
    """カット内の単語列を2〜4秒粒度のまとまり(run)に分割する。

    境界規則:
    - スロット長が MIN_SLOT_MS 以上で、(a) 次単語までのギャップが SLOT_BREAK_GAP_MS 以上、
      または (b) 文末記号で終わる、場合に分割する
    - 次の単語まで含めると MAX_SLOT_MS を超える場合は、FORCE_BREAK_MIN_MS 以上あれば強制分割する
    """
    runs: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    for index, word in enumerate(seg_words):
        current.append(word)
        nxt = seg_words[index + 1] if index + 1 < len(seg_words) else None
        if nxt is None:
            break
        first_start = int(current[0].get("start_ms", seg_start_ms))
        elapsed = int(word.get("end_ms", 0)) - first_start
        gap = int(nxt.get("start_ms", 0)) - int(word.get("end_ms", 0))
        text = str(word.get("text", ""))
        sentence_end = bool(text) and text[-1] in _SENTENCE_END_CHARS
        would_exceed = int(nxt.get("end_ms", 0)) - first_start > MAX_SLOT_MS
        natural_break = elapsed >= MIN_SLOT_MS and (gap >= SLOT_BREAK_GAP_MS or sentence_end)
        force_break = would_exceed and elapsed >= FORCE_BREAK_MIN_MS
        if natural_break or force_break:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return runs


def build_slots(
    keep_segments: List[Dict[str, Any]],
    words: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """keep_segments と word timing からテロップ表示スロットを機械分割する。

    Returns:
        [{"slot_id", "cut_id", "cut_index", "start_ms", "end_ms",
          "source_start_ms", "source_end_ms", "text"}]
        start_ms/end_ms は生成時点のカット内相対、source_*_ms は元動画の絶対ms。
        各カットのスロットはカット全体を隙間なくカバーする。
    """
    slots: List[Dict[str, Any]] = []
    for cut_index, seg in enumerate(keep_segments):
        cut_id = f"cut_{cut_index + 1:03d}"
        seg_start = int(seg["start_ms"])
        seg_end = int(seg["end_ms"])
        duration = seg_end - seg_start
        if duration <= 0:
            continue
        seg_words = _words_in_segment(words, seg)

        def _append_slot(counter: int, rel_start: int, rel_end: int, text: str) -> None:
            slots.append({
                "slot_id": f"{cut_id}_s{counter:02d}",
                "cut_id": cut_id,
                "cut_index": cut_index,
                "start_ms": rel_start,
                "end_ms": rel_end,
                "source_start_ms": seg_start + rel_start,
                "source_end_ms": seg_start + rel_end,
                "text": text,
            })

        if not seg_words:
            text = _clean_slot_text(str(seg.get("text", "")))
            if text:
                _append_slot(0, 0, duration, text)
            continue

        runs = _split_words_into_runs(seg_words, seg_start)
        # スロット境界は「前runの最終単語の終了」と「次runの先頭単語の開始」の中点に置く
        # (カット全体を隙間なくカバーし、UIのシーン境界とも一致させるため)
        boundaries: List[int] = [0]
        for run, next_run in zip(runs, runs[1:]):
            prev_end = int(run[-1].get("end_ms", seg_start)) - seg_start
            next_start = int(next_run[0].get("start_ms", seg_start)) - seg_start
            midpoint = (prev_end + next_start) // 2
            boundaries.append(max(0, min(duration, midpoint)))
        boundaries.append(duration)

        slot_counter = 0
        for k, run in enumerate(runs):
            rel_start = boundaries[k]
            rel_end = boundaries[k + 1]
            if rel_end <= rel_start:
                continue
            text = _clean_slot_text("".join(str(w.get("text", "")) for w in run))
            if not text:
                continue
            _append_slot(slot_counter, rel_start, rel_end, text)
            slot_counter += 1
    return slots


# ---------------------------------------------------------------------------
# 2. AI応答の検証・フォールバック安全弁
# ---------------------------------------------------------------------------

# 内容語トークン: 漢字連続 / カタカナ2文字以上 / 英数字語
_CONTENT_TOKEN_RE = re.compile(r"[一-龥々]+|[ァ-ヶー]{2,}|[A-Za-z0-9][A-Za-z0-9.%&+\-]*")


def _normalize_for_match(text: str) -> str:
    """照合用の正規化(NFKC+漢数字→算用数字+小文字化)。

    「三十万円」(元発話)と「30万円」(AI整形)を同一視するため、両辺に同じ正規化をかける。
    """
    normalized = unicodedata.normalize("NFKC", text or "")
    normalized = _normalize_kanji_numbers(normalized)
    return normalized.lower()


def is_text_faithful(source_text: str, candidate_text: str) -> bool:
    """AI整形文言が元発話に忠実か(意味の創作をしていないか)を判定する。

    候補文言の内容語トークンのうち、元テキスト(正規化後)に部分文字列として
    見つからないものが過半なら不忠実(False)とする。
    """
    source_norm = _normalize_for_match(source_text)
    candidate_norm = _normalize_for_match(candidate_text)
    tokens = _CONTENT_TOKEN_RE.findall(candidate_norm)
    if not tokens:
        return True
    missing = [token for token in tokens if token not in source_norm]
    return len(missing) * 2 <= len(tokens)


def sanitize_style(style: Any) -> str:
    """AIが返したスタイルIDを許可リストへ正規化する(不明・欠落は fact_yellow)。"""
    if isinstance(style, str) and style in ALLOWED_DIRECTIVE_STYLES:
        return style
    return DEFAULT_DIRECTIVE_STYLE


def sanitize_highlight_words(highlight_words: Any, text: str, max_words: int = 3) -> List[str]:
    """highlight_words を「最終テロップ文言に実在する部分文字列」だけに絞る。"""
    if not isinstance(highlight_words, list):
        return []
    result: List[str] = []
    for word in highlight_words:
        candidate = str(word or "").strip()
        if candidate and candidate in text and candidate not in result:
            result.append(candidate)
        if len(result) >= max_words:
            break
    return result


def effective_slot_style(slot: Dict[str, Any], type_mapping: Optional[Dict[str, str]] = None) -> str:
    """スロットの有効スタイルIDを解決する(step08実行時・UI適用時の再解決)。

    優先順位:
    1. style_overridden=True の明示スタイル(UIでの個別プリセット上書き)
    2. semantic type → preset マッピング(ユーザー設定を反映した最新のマッピング)
    3. スロットに保存された style スナップショット(T2の旧ディレクティブ=type無し の後方互換)
    """
    explicit = slot.get("style")
    has_explicit = isinstance(explicit, str) and explicit in ALLOWED_DIRECTIVE_STYLES
    if slot.get("style_overridden") and has_explicit:
        return explicit
    slot_type = slot.get("type")
    if isinstance(slot_type, str) and slot_type in SEMANTIC_TYPES:
        return sanitize_style(resolve_style_for_type(slot_type, type_mapping))
    return explicit if has_explicit else DEFAULT_DIRECTIVE_STYLE


def effective_slot_animation(
    slot: Dict[str, Any],
    type_mapping: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """スロットの登場アニメーションを解決する(フェーズT3)。

    優先順位:
    1. スロットの animation_in(UIピッカーの個別上書き。存在=上書き)
    2. semantic type → マッピングの animation_in(ユーザー設定)
    3. None(=composition には書かず、描画側がプリセット既定 → timeline 既定へフォールバック)
    """
    explicit = slot.get("animation_in")
    if isinstance(explicit, str) and explicit in ANIMATION_IN_TYPES:
        return explicit
    slot_type = slot.get("type")
    if isinstance(slot_type, str) and slot_type in SEMANTIC_TYPES:
        return resolve_animation_for_type(slot_type, type_mapping)
    return None


def effective_slot_sfx(
    slot: Dict[str, Any],
    type_mapping: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, Optional[str]]:
    """スロットの効果音を解決する(フェーズT3)。

    Returns:
        (write, value):
        - write=False → composition の telop に sfx を書かない(プリセット既定に任せる)
        - write=True, value=None → "sfx": null を書く(明示的に鳴らさない)
        - write=True, value=str  → その効果音IDを書く(プリセットより優先)

    優先順位:
    1. スロットの sfx: false → 明示OFF / sfx: true → 鳴らす意図(IDはマッピング→プリセットに任せる)
    2. semantic type → マッピングの sfx(ID指定 or "none")
    3. 書かない(プリセット既定)
    """
    raw = slot.get("sfx")
    if raw is False:
        return True, None
    slot_type = slot.get("type")
    mapped = (
        resolve_sfx_for_type(slot_type, type_mapping)
        if isinstance(slot_type, str) and slot_type in SEMANTIC_TYPES
        else None
    )
    if mapped == "none":
        # slot が sfx: true を明示している場合はマッピングの「鳴らさない」より意図を優先し、
        # プリセット既定のIDで鳴らす(フィールドは書かない)
        return (False, None) if raw is True else (True, None)
    if isinstance(mapped, str) and mapped:
        return True, mapped
    return False, None


def sanitize_slot_directive(
    slot: Dict[str, Any],
    raw: Optional[Dict[str, Any]],
    type_mapping: Optional[Dict[str, str]] = None,
    max_text_chars: Optional[float] = None,
) -> Dict[str, Any]:
    """AI応答の1スロット分を検証し、表示に使う最終ディレクティブを返す。

    - text が空/欠落、元発話に対して不忠実(内容語の過半が元に無い)、または
      文字数上限(max_text_chars: 2行×行バジェットの重み付き文字数)超過なら
      元テキストへフォールバックする(安全弁。AI再依頼はしない)
    - type は10種へ正規化し、style はマッピング解決済みの結果として出力する(後方互換)。
      AIが有効な style を明示した場合(旧形式)はそれを尊重する
    - highlight_words は最終文言に実在する語のみ残す
    """
    source_text = str(slot.get("text", ""))
    raw = raw if isinstance(raw, dict) else {}

    text = str(raw.get("text", "") or "").replace("\n", "").strip()
    text = _PERIOD_RE.sub("", text)
    fallback = False
    if not text or not is_text_faithful(source_text, text):
        text = source_text
        fallback = True
    elif max_text_chars is not None and glyph_length(text, "weighted_cpl") > max_text_chars:
        # 文字数上限超過: 末尾を切らず元発話へフォールバック(描画側の縮小・折返しに任せる)
        text = source_text
        fallback = True

    semantic_type = sanitize_semantic_type(raw.get("type"))
    raw_style = raw.get("style")
    if isinstance(raw_style, str) and raw_style in ALLOWED_DIRECTIVE_STYLES:
        style = raw_style
    else:
        style = sanitize_style(resolve_style_for_type(semantic_type, type_mapping))
    highlight_words = sanitize_highlight_words(raw.get("highlight_words"), text)

    return {
        "slot_id": str(slot["slot_id"]),
        "cut_id": str(slot["cut_id"]),
        "source_start_ms": int(slot["source_start_ms"]),
        "source_end_ms": int(slot["source_end_ms"]),
        "source_text": source_text,
        "text": text,
        "type": semantic_type,
        "style": style,
        "highlight_words": highlight_words,
        "fallback": fallback,
    }


def sanitize_overlay_suggestion(
    raw: Any,
    slots_by_id: Dict[str, Dict[str, Any]],
    index: int,
) -> Optional[Dict[str, Any]]:
    """AIのオーバーレイ提案1件を検証する(不正な type / slot_id は破棄)。

    表示アンカーは参照スロットの絶対開始ms(source_anchor_ms)として保存する。
    """
    if not isinstance(raw, dict):
        return None
    overlay_type = str(raw.get("type", ""))
    if overlay_type not in ALLOWED_OVERLAY_TYPES:
        return None
    slot = slots_by_id.get(str(raw.get("slot_id", "")))
    if slot is None:
        return None

    overlay: Dict[str, Any] = {
        "id": f"ov_{overlay_type}_{index:02d}",
        "type": overlay_type,
        "source_anchor_ms": int(slot["source_start_ms"]),
        "position": OVERLAY_DEFAULT_POSITION[overlay_type],
    }
    text = str(raw.get("text", "") or "").strip()
    subtitle = str(raw.get("subtitle", "") or "").strip()
    lines = raw.get("lines")
    clean_lines = [str(ln).strip() for ln in lines if str(ln).strip()] if isinstance(lines, list) else []

    if overlay_type == "profile_card":
        if not text:
            return None
        overlay["text"] = text
        if subtitle:
            overlay["subtitle"] = subtitle
    elif overlay_type == "list_stack":
        if len(clean_lines) < 2:
            return None
        overlay["lines"] = clean_lines[:6]
    else:  # cta_banner
        if not clean_lines and not text:
            return None
        overlay["lines"] = clean_lines[:2] if clean_lines else [text]
    return overlay


def sanitize_chapters(
    raw_chapters: Any,
    keep_segments: List[Dict[str, Any]],
    max_title_chars: int = 18,
) -> List[Dict[str, Any]]:
    """AIのチャプター提案を検証する。

    - start_cut_id が実在しないもの・タイトル空は破棄
    - カット順に整列・重複開始カットは先勝ち
    - 先頭チャプターの開始は必ず先頭カットに揃える(タイムライン全体をカバーするため)
    - 開始位置は該当カットの絶対開始ms(source_start_ms)として保存する
    """
    if not isinstance(raw_chapters, list) or not keep_segments:
        return []
    source_start_by_cut = {
        f"cut_{i + 1:03d}": int(seg["start_ms"]) for i, seg in enumerate(keep_segments)
    }
    order = {cut_id: i for i, cut_id in enumerate(source_start_by_cut)}
    picked: Dict[str, str] = {}
    for item in raw_chapters:
        if not isinstance(item, dict):
            continue
        cut_id = str(item.get("start_cut_id", ""))
        title = str(item.get("title", "") or "").strip()
        if cut_id not in order or not title:
            continue
        if cut_id not in picked:
            picked[cut_id] = title[:max_title_chars]
    if not picked:
        return []
    ordered = sorted(picked.items(), key=lambda kv: order[kv[0]])
    # タイムライン全体をカバー: 先頭チャプターの開始を先頭カットへ強制する
    first_cut_id = next(iter(source_start_by_cut))
    if ordered[0][0] != first_cut_id:
        ordered[0] = (first_cut_id, ordered[0][1])
    return [
        {
            "id": f"chapter_{i + 1:02d}",
            "source_start_ms": source_start_by_cut[cut_id],
            "title": title,
        }
        for i, (cut_id, title) in enumerate(ordered)
    ]


# ---------------------------------------------------------------------------
# 3. directed モードの composition 素材生成 (step08 が使う)
# ---------------------------------------------------------------------------

def select_slots_for_cut(
    slots: List[Dict[str, Any]],
    seg_start_ms: int,
    seg_end_ms: int,
) -> List[Dict[str, Any]]:
    """現在のkeep_segment(カット)に属するスロットを絶対msアンカーから選び直す。

    生成後にUIでカットがトリム・分割されていても、スロットの絶対中点が区間内にあれば
    そのカットのスロットとして採用し、区間内にクランプしたカット相対タイミングを返す。
    """
    selected: List[Dict[str, Any]] = []
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        src_start = int(slot.get("source_start_ms", -1))
        src_end = int(slot.get("source_end_ms", -1))
        if src_end <= src_start:
            continue
        midpoint = (src_start + src_end) / 2
        if not (seg_start_ms <= midpoint < seg_end_ms):
            continue
        rel_start = max(0, src_start - seg_start_ms)
        rel_end = min(seg_end_ms, src_end) - seg_start_ms
        if rel_end <= rel_start:
            continue
        selected.append({**slot, "start_ms": rel_start, "end_ms": rel_end})
    selected.sort(key=lambda s: int(s["start_ms"]))
    return selected


def wrap_directive_lines(text: str, max_chars_per_line: int) -> List[str]:
    """ディレクティブ文言を最大2行に折り返す(BudouXの語境界を使う)。

    directed テロップは1スロット=1ページ固定のため、規定幅で2行に収まらない場合は
    行幅を広げてでも必ず1ページ(≤2行)に収める(Remotion側が幅フィットで縮小する)。
    """
    stripped = (text or "").strip()
    if not stripped:
        return []
    for width in range(max(4, max_chars_per_line), len(stripped) + 1):
        pages = split_pages(stripped, max_chars_per_line=width, max_lines_per_page=2)
        if len(pages) == 1 and pages[0].get("lines"):
            return [str(line) for line in pages[0]["lines"]]
    return [stripped]


def build_directed_cut_content(
    cut_id: str,
    slots: List[Dict[str, Any]],
    voice_words: List[Dict[str, Any]],
    duration_ms: int,
    max_chars_per_line: int,
    type_mapping: Optional[Dict[str, str]] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """1カット分の directed テロップ(timeline pages / voice telops)を組み立てる。

    - タイミングはスロット区間の固定表示(明示 start/end 秒。word単位カラオケ同期はしない)
    - word_indices はスロット区間に重なる語のindex(UIのシーン境界抽出のフォールバック用。
      描画は明示 start/end が優先されるため使われない)
    - voice_words は build_voice_data と同じ形({"text","start","end"}: 秒単位・カット相対)
    - フェーズT2.5-4: スタイルは effective_slot_style で毎回解決する
      (semantic type × 最新マッピング。UIの個別上書き=style_overridden はマッピングより優先)
    - フェーズT3: 登場アニメーション(effective_slot_animation)・効果音(effective_slot_sfx)も
      毎回解決し、プリセット既定と異なる場合のみ telop に書く(描画側の優先順位:
      telop明示 > プリセット既定 > timeline既定)
    """
    pages: List[Dict[str, Any]] = []
    telops: List[Dict[str, Any]] = []
    for slot in slots:
        start_ms = max(0, min(int(slot.get("start_ms", 0)), duration_ms))
        end_ms = max(0, min(int(slot.get("end_ms", 0)), duration_ms))
        if end_ms <= start_ms:
            continue
        lines = wrap_directive_lines(str(slot.get("text", "")), max_chars_per_line)
        if not lines:
            continue
        page_index = len(pages)
        page_id = f"{cut_id}_p{page_index:02d}"
        text = "".join(lines)
        highlight_words = sanitize_highlight_words(slot.get("highlight_words"), text)
        style = effective_slot_style(slot, type_mapping)
        animation_in = effective_slot_animation(slot, type_mapping)
        sfx_write, sfx_value = effective_slot_sfx(slot, type_mapping)
        slot_type = slot.get("type")
        semantic_type = slot_type if isinstance(slot_type, str) and slot_type in SEMANTIC_TYPES else None

        page: Dict[str, Any] = {
            "id": page_id,
            "lines": lines,
            "style": style,
            "start_ms": start_ms,
            "end_ms": end_ms,
        }
        if semantic_type:
            page["type"] = semantic_type
        if highlight_words:
            page["highlight_words"] = highlight_words
        pages.append(page)

        word_indices = [
            i for i, w in enumerate(voice_words)
            if float(w.get("end", 0)) * 1000 > start_ms and float(w.get("start", 0)) * 1000 < end_ms
        ]
        telop: Dict[str, Any] = {
            "id": page_id,
            "text": text,
            "word_indices": word_indices,
            "segments": [{"text": line, "word_indices": []} for line in lines],
            "start": round(start_ms / 1000.0, 3),
            "end": round(end_ms / 1000.0, 3),
            "style": style,
        }
        if semantic_type:
            telop["type"] = semantic_type
        if slot.get("style_overridden"):
            # UIの個別プリセット上書きを保持する(UIがシーン再初期化時に上書き状態を復元するため)
            telop["style_overridden"] = True
        if animation_in:
            telop["animation_in"] = animation_in
            if isinstance(slot.get("animation_in"), str) and slot["animation_in"] in ANIMATION_IN_TYPES:
                # UIピッカーの個別上書き由来であることを保持する(シーン再初期化時の復元用)
                telop["animation_overridden"] = True
        if sfx_write:
            telop["sfx"] = sfx_value
        if highlight_words:
            telop["highlight_words"] = highlight_words
        telops.append(telop)
    return pages, telops


def map_source_ms_to_timeline(
    source_ms: int,
    segments: List[Dict[str, int]],
) -> Optional[int]:
    """元動画の絶対msをタイムラインms(カット除去後)へ写像する。

    segments: [{"source_start_ms","source_end_ms","timeline_start_ms"}] (時系列順)。
    カット済み区間(隙間)に落ちた場合は次のセグメント先頭へスナップする。
    全セグメントより後ろならNone(タイムライン外)。
    """
    for seg in segments:
        if source_ms < seg["source_start_ms"]:
            return seg["timeline_start_ms"]
        if source_ms < seg["source_end_ms"]:
            return seg["timeline_start_ms"] + (source_ms - seg["source_start_ms"])
    return None


def build_directed_overlays(
    directives: Dict[str, Any],
    segments: List[Dict[str, int]],
    total_duration_ms: int,
) -> List[Dict[str, Any]]:
    """telop_directives.json のチャプター/オーバーレイ提案を timeline.overlays へ変換する。

    Args:
        segments: [{"source_start_ms","source_end_ms","timeline_start_ms"}] (時系列順)
        total_duration_ms: 編集後タイムラインの総尺(ms)
    """
    overlays: List[Dict[str, Any]] = []

    # チャプター: 各章は次章の開始まで表示し、全体でタイムラインをカバーする
    chapters = [
        ch for ch in (directives.get("chapters") or [])
        if isinstance(ch, dict) and str(ch.get("title", "")).strip()
    ]
    chapter_starts: List[Tuple[int, Dict[str, Any]]] = []
    for chapter in chapters:
        mapped = map_source_ms_to_timeline(int(chapter.get("source_start_ms", 0)), segments)
        if mapped is None:
            continue
        chapter_starts.append((mapped, chapter))
    chapter_starts.sort(key=lambda pair: pair[0])
    for i, (start_ms, chapter) in enumerate(chapter_starts):
        effective_start = 0 if i == 0 else start_ms
        end_ms = chapter_starts[i + 1][0] if i + 1 < len(chapter_starts) else total_duration_ms
        if end_ms <= effective_start:
            continue
        overlays.append({
            "id": str(chapter.get("id") or f"chapter_{i + 1:02d}"),
            "type": "chapter_title",
            "start_ms": effective_start,
            "end_ms": end_ms,
            "text": str(chapter["title"]).strip(),
            "position": "top_left",
        })

    # profile_card / list_stack / cta_banner: アンカー位置から既定時間で表示する
    for index, overlay in enumerate(directives.get("overlays") or []):
        if not isinstance(overlay, dict):
            continue
        overlay_type = str(overlay.get("type", ""))
        if overlay_type not in ALLOWED_OVERLAY_TYPES:
            continue
        start_ms = map_source_ms_to_timeline(int(overlay.get("source_anchor_ms", -1)), segments)
        if start_ms is None or start_ms >= total_duration_ms:
            continue
        end_ms = min(total_duration_ms, start_ms + OVERLAY_DEFAULT_DURATION_MS[overlay_type])
        if end_ms <= start_ms:
            continue
        item: Dict[str, Any] = {
            "id": str(overlay.get("id") or f"ov_{overlay_type}_{index:02d}"),
            "type": overlay_type,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "position": str(overlay.get("position") or OVERLAY_DEFAULT_POSITION[overlay_type]),
        }
        if overlay.get("text"):
            item["text"] = str(overlay["text"])
        if overlay.get("subtitle"):
            item["subtitle"] = str(overlay["subtitle"])
        if isinstance(overlay.get("lines"), list) and overlay["lines"]:
            item["lines"] = [str(ln) for ln in overlay["lines"]]
        overlays.append(item)

    return overlays

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
from shared.line_break_rules import repair_line_breaks
from shared.speakers import dominant_speaker
from shared.telop_builder import _normalize_kanji_numbers, normalize_directed_display_text
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
# op_brushはOP専用のため除外)。フェーズT2.5-3で明朝系(serif_quote/serif_harsh)を追加。
# フェーズU2: 使用シーン(Vlog系)のマッピングが座布団(帯)プリセットを使うため
# band系を許可(許可しないと effective_slot_style の sanitize で fact_yellow に落ちる)
# フェーズU5: ジャンル別プリセット(business/vlog/variety/beauty/game)を追加。
# design_scenes.yaml が参照するプリセットは必ずここと UI(DIRECTED_STYLE_OPTIONS)の
# 両方に載せる(載せないと step08 の sanitize で fact_yellow に落ちる)
ALLOWED_DIRECTIVE_STYLES = (
    "fact_yellow",
    "fact_yellow_band",
    "neutral_white",
    "neutral_white_band",
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
    # --- フェーズU5: ジャンル別プロプリセット ---
    "biz_white",
    "biz_blue",
    "biz_navy_box",
    "vlog_caption",
    "vlog_caption_strong",
    "variety_yellow",
    "variety_pop_red",
    "variety_hand_shock",
    "beauty_serif",
    "beauty_pink",
    "beauty_gold",
    "game_neon_cyan",
    "game_neon_magenta",
    "game_retro_dot",
    # --- フェーズW1: 話者カラー用プリセット(fact_yellowの色違い) ---
    "fact_cyan",
    "fact_green",
    # --- フェーズW24/W26: 縦型ショート広告のデザインシステム(4スタイル) ---
    "ad_gothic_impact",
    "ad_mincho_impact",
    "ad_highlight_band",
    "ad_urgent_band",
    # --- フェーズW27: 縦型ショートのアクセント3種(特大・斜め・縦書き) ---
    "ad_mega_impact",
    "ad_slant_impact",
    "ad_vertical_mincho",
)
DEFAULT_DIRECTIVE_STYLE = "fact_yellow"

# スロット分割の粒度(仕様書「2〜4秒粒度」)
MIN_SLOT_MS = 2000
MAX_SLOT_MS = 4000
# この無音ギャップを超えたらスロット境界の候補にする
SLOT_BREAK_GAP_MS = 350
# 上限超過を避けるための強制分割時に許容する最小スロット長
FORCE_BREAK_MIN_MS = 1200

# フェーズW30(意味の塊分割): 時間ではなく文字数(全角換算)と文構造で切る。
# target_chars: 1行に収まる目安。文節の切れ目でこの長さ以上なら切る
# max_chars: 2行相当の上限。次の単語を足すと超える場合は切れ目らしい位置まで遡って強制分割
DEFAULT_SLOT_TARGET_CHARS = 14
DEFAULT_SLOT_MAX_CHARS = 26
# これ未満の文字数では分割しない(1〜3文字の断片スロットを作らない)
SLOT_MIN_CHARS = 4

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

# フェーズW3: cta_banner と CTAテロップの二重表示回避。
# AIはバナーを「話者がCTAを言った瞬間」にアンカーするため、そのままだと同じ文言の
# CTAテロップ(type=cta のスロット)と同時刻・同領域に黄色ボックスが2枚重なる
# (実データ 20260707_194708 で確認)。バナーは競合区間の直後へずらして表示する。
CTA_BANNER_AVOID_MARGIN_MS = 300
# ずらした結果この尺を確保できない場合はバナー自体を出さない(動画末尾のCTA連発など)
CTA_BANNER_MIN_DURATION_MS = 1500

_SENTENCE_END_CHARS = set("。！？!?")
_PERIOD_RE = re.compile(r"[。]")

# フェーズW27: 強制分割の遡り候補に使う「切れ目らしい語尾」。
# 読点・助詞・接続で終わる単語の直後は文節境界の可能性が高い(word単位STTの範囲での近似)。
_SOFT_BREAK_SUFFIXES = (
    "、", "は", "が", "を", "に", "で", "と", "も", "へ",
    "から", "まで", "ので", "けど", "が、", "て", "し",
)
# 強制分割の遡りで切れ目候補とみなす最小ギャップ(ms)。SLOT_BREAK_GAP_MS(350)より緩い
_SOFT_BREAK_GAP_MS = 120


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


def _word_len(word: Dict[str, Any]) -> float:
    """単語の表示文字数(全角換算・weighted_cpl)。"""
    return glyph_length(str(word.get("text", "")), "weighted_cpl")


# フェーズW30: 文節境界の判定にBudouXを使う。語尾1文字の助詞判定(「し」「に」「て」等)は
# STT単語が語の途中で切れているケース(「決し|て」「間に|合う」「立て|方」)を
# 文節境界と誤検出してテロップの語中切りを量産していた。
try:
    import budoux as _budoux

    _BUDOUX_PARSER = _budoux.load_default_japanese_parser()
except Exception:  # pragma: no cover - budoux未導入環境のフォールバック
    _BUDOUX_PARSER = None


# BudouXが誤って内部を割る複合語(「Nに+動詞」型など)。この文字列の内部に落ちた
# 境界は無効化する(例: BudouXは「間に|合わない」と割る)。
_NO_BREAK_COMPOUNDS = (
    "間に合", "手に入", "気に入", "身に付", "身につ", "役に立", "目に遭", "口に出",
)


def _phrase_safe_flags(seg_words: List[Dict[str, Any]]) -> Optional[List[bool]]:
    """各単語の「直後で切ってよいか」(BudouX文節境界)のフラグ列を返す。

    セグメント全文をBudouXで文節分割し、単語末尾の文字オフセットが文節境界に
    一致する単語だけ True。禁則複合語(_NO_BREAK_COMPOUNDS)の内部に落ちた境界は
    無効化する。BudouXが使えない場合は None(呼び出し側で語尾判定へフォールバック)。
    """
    if _BUDOUX_PARSER is None:
        return None
    full_text = "".join(str(w.get("text", "")) for w in seg_words)
    if not full_text:
        return None
    try:
        chunks = _BUDOUX_PARSER.parse(full_text)
    except Exception:
        return None
    boundaries = set()
    pos = 0
    for chunk in chunks:
        pos += len(chunk)
        boundaries.add(pos)
    for compound in _NO_BREAK_COMPOUNDS:
        start = full_text.find(compound)
        while start != -1:
            for inner in range(start + 1, start + len(compound)):
                boundaries.discard(inner)
            start = full_text.find(compound, start + 1)
    flags: List[bool] = []
    pos = 0
    for w in seg_words:
        pos += len(str(w.get("text", "")))
        flags.append(pos in boundaries)
    return flags


def _soft_break_index(
    current: List[Dict[str, Any]],
    seg_words: List[Dict[str, Any]],
    base_index: int,
    phrase_flags: Optional[List[bool]] = None,
) -> Optional[int]:
    """強制分割時の遡り: current内で最も後ろの「切れ目らしい単語」のindexを返す。

    フェーズW27(ぶつ切りテロップ対策): 上限到達位置の単語でそのまま切ると
    「具体的にアドバイスをすることができま / す私たちは」のような語の途中の分断が起きる。
    フェーズW30: 切れ目の判定はBudouX文節境界(phrase_flags)を最優先。
    使えない場合のみ読点・助詞語尾・ギャップの近似へフォールバックする。
    切った前半が SLOT_MIN_CHARS 文字以上残る最も後ろの候補を選ぶ。候補が無ければ None。
    """
    prefix_lens: List[float] = []
    total = 0.0
    for w in current:
        total += _word_len(w)
        prefix_lens.append(total)
    for offset in range(len(current) - 1, -1, -1):
        if prefix_lens[offset] < SLOT_MIN_CHARS:
            return None
        word = current[offset]
        text = str(word.get("text", ""))
        seg_index = base_index - (len(current) - 1 - offset)
        if phrase_flags is not None:
            if 0 <= seg_index < len(phrase_flags) and phrase_flags[seg_index]:
                return offset
            continue
        nxt = seg_words[seg_index + 1] if seg_index + 1 < len(seg_words) else None
        gap = int(nxt.get("start_ms", 0)) - int(word.get("end_ms", 0)) if nxt else 0
        is_soft = bool(text) and (
            text.endswith(_SOFT_BREAK_SUFFIXES) or text[-1] in _SENTENCE_END_CHARS
        )
        if is_soft or gap >= _SOFT_BREAK_GAP_MS:
            return offset
    return None


def _split_words_into_runs(
    seg_words: List[Dict[str, Any]],
    seg_start_ms: int,
    target_chars: float = DEFAULT_SLOT_TARGET_CHARS,
    max_chars: float = DEFAULT_SLOT_MAX_CHARS,
) -> List[List[Dict[str, Any]]]:
    """カット内の単語列を「意味の塊」(文・文節)単位のまとまり(run)に分割する。

    フェーズW30(意味の塊分割): 従来は2〜4秒の時間粒度で切っていたため、前の文の終わりと
    次の文の頭が同じテロップに同居する(「長くはありませんそして部活が…」)、語の途中で
    切れる、といった分割ミスがスロットの大半で起きていた。時間ではなく文字数と文構造で切る:
    - 文末記号(。！？)の直後、または SLOT_BREAK_GAP_MS 以上のギャップでは必ず切る
      (現runが SLOT_MIN_CHARS 文字以上ある場合。2つの文を1テロップに同居させない)
    - BudouX文節境界では、target_chars(1行分)以上たまっていたら切る
      (1テロップ=1文節前後のリズムを作る。語尾1文字の助詞近似は語中切りを生むため
       BudouXが使える環境では使わない)
    - 次の単語を足すと max_chars(2行分)または MAX_SLOT_MS を超える場合は、
      文節境界まで遡って強制分割する(W27の遡りを文字数基準で継承)
    - 末尾に数文字の断片runが残った場合は前のrunへ併合する(「模試の」単独テロップ対策)
    """
    phrase_flags = _phrase_safe_flags(seg_words)
    runs: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    acc_len = 0.0
    index = 0
    while index < len(seg_words):
        word = seg_words[index]
        current.append(word)
        acc_len += _word_len(word)
        nxt = seg_words[index + 1] if index + 1 < len(seg_words) else None
        if nxt is None:
            break
        first_start = int(current[0].get("start_ms", seg_start_ms))
        gap = int(nxt.get("start_ms", 0)) - int(word.get("end_ms", 0))
        text = str(word.get("text", ""))
        sentence_end = bool(text) and text[-1] in _SENTENCE_END_CHARS
        if phrase_flags is not None:
            clause_end = phrase_flags[index]
        else:
            clause_end = (bool(text) and text.endswith(_SOFT_BREAK_SUFFIXES)) or gap >= _SOFT_BREAK_GAP_MS
        would_exceed_chars = acc_len + _word_len(nxt) > max_chars
        would_exceed_ms = int(nxt.get("end_ms", 0)) - first_start > MAX_SLOT_MS
        hard_break = acc_len >= SLOT_MIN_CHARS and (sentence_end or gap >= SLOT_BREAK_GAP_MS)
        clause_break = acc_len >= target_chars and clause_end
        if hard_break or clause_break:
            runs.append(current)
            current = []
            acc_len = 0.0
        elif would_exceed_chars or would_exceed_ms:
            soft = _soft_break_index(current, seg_words, index, phrase_flags=phrase_flags)
            if soft is not None and soft < len(current) - 1:
                # 切れ目候補まで遡って切り、残りは次runへ持ち越す
                runs.append(current[: soft + 1])
                current = current[soft + 1 :]
                acc_len = sum(_word_len(w) for w in current)
            elif acc_len >= SLOT_MIN_CHARS:
                runs.append(current)
                current = []
                acc_len = 0.0
        index += 1
    if current:
        runs.append(current)
    if len(runs) >= 2:
        tail_len = sum(_word_len(w) for w in runs[-1])
        prev_len = sum(_word_len(w) for w in runs[-2])
        if tail_len < SLOT_MIN_CHARS and prev_len + tail_len <= max_chars + 4:
            runs[-2].extend(runs.pop())
    return runs


def build_slots(
    keep_segments: List[Dict[str, Any]],
    words: List[Dict[str, Any]],
    target_chars: float = DEFAULT_SLOT_TARGET_CHARS,
    max_chars: float = DEFAULT_SLOT_MAX_CHARS,
) -> List[Dict[str, Any]]:
    """keep_segments と word timing からテロップ表示スロットを機械分割する。

    フェーズW30: target_chars/max_chars(全角換算)はプロジェクトの1行文字数設定から渡す
    (縦型=1行11字なら target=11/max=22)。意味の塊分割の詳細は _split_words_into_runs 参照。

    Returns:
        [{"slot_id", "cut_id", "cut_index", "start_ms", "end_ms",
          "source_start_ms", "source_end_ms", "text", "speaker"?}]
        start_ms/end_ms は生成時点のカット内相対、source_*_ms は元動画の絶対ms。
        各カットのスロットはカット全体を隙間なくカバーする。
        フェーズW1: 区間wordsに speaker があれば dominant speaker(発話時間の過半)を
        "speaker" として付与する(無ければフィールド自体なし=後方互換)。
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

        def _append_slot(
            counter: int, rel_start: int, rel_end: int, text: str, speaker: Optional[str] = None,
        ) -> None:
            slot: Dict[str, Any] = {
                "slot_id": f"{cut_id}_s{counter:02d}",
                "cut_id": cut_id,
                "cut_index": cut_index,
                "start_ms": rel_start,
                "end_ms": rel_end,
                "source_start_ms": seg_start + rel_start,
                "source_end_ms": seg_start + rel_end,
                "text": text,
            }
            if speaker:
                slot["speaker"] = speaker
            slots.append(slot)

        if not seg_words:
            text = _clean_slot_text(str(seg.get("text", "")))
            if text:
                _append_slot(0, 0, duration, text)
            continue

        runs = _split_words_into_runs(seg_words, seg_start, target_chars=target_chars, max_chars=max_chars)
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
            _append_slot(slot_counter, rel_start, rel_end, text, speaker=dominant_speaker(run))
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

    フェーズW27: 数字を含むトークンは1つでも元に無ければ即不忠実とする。
    「創業から十七年」を「19年」と表示する事故(数値の捏造)は過半ルールでは
    素通りするため、数字だけは厳格に照合する(漢数字は正規化で算用数字に揃うので
    「三十万円」→「30万円」のような正しい変換は通る)。
    """
    source_norm = _normalize_for_match(source_text)
    candidate_norm = _normalize_for_match(candidate_text)
    tokens = _CONTENT_TOKEN_RE.findall(candidate_norm)
    if not tokens:
        return True
    missing = [token for token in tokens if token not in source_norm]
    if any(any(ch.isdigit() for ch in token) for token in missing):
        return False
    return len(missing) * 2 <= len(tokens)


def sanitize_style(style: Any, allowed_custom: Any = ()) -> str:
    """スタイルIDを許可リストへ正規化する(不明・欠落は fact_yellow)。

    フェーズU6: allowed_custom に「定義付きで供給されたカスタムスタイルID」を渡すと、
    そのIDも許可する(定義が composition の telop_styles へ注入されることが前提。
    定義の無いIDを許可すると描画側でフォールバック描画になるため弾く)。
    """
    if isinstance(style, str) and (style in ALLOWED_DIRECTIVE_STYLES or style in allowed_custom):
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


def effective_slot_style(
    slot: Dict[str, Any],
    type_mapping: Optional[Dict[str, str]] = None,
    allowed_custom: Any = (),
    speaker_colors: Optional[Dict[str, Any]] = None,
) -> str:
    """スロットの有効スタイルIDを解決する(step08実行時・UI適用時の再解決)。

    優先順位:
    1. style_overridden=True の明示スタイル(UIでの個別プリセット上書き)
    2. 話者カラー(フェーズW1。speaker_colors が渡され、slotのtypeが apply_types に含まれ、
       slotの speaker が styles マッピングにある場合のみ)
    3. semantic type → preset マッピング(ユーザー設定を反映した最新のマッピング)
    4. スロットに保存された style スナップショット(T2の旧ディレクティブ=type無し の後方互換)

    フェーズU6: allowed_custom(定義付きカスタムスタイルID)は明示スタイル・
    マッピング解決の両方で許可される。
    フェーズW1: speaker_colors は「発動条件(enabled+実質2話者以上)を満たした場合のみ」
    呼び出し側が渡す {"apply_types": 集合/列, "styles": {speaker_id: style_id}}。
    None なら話者カラーは一切効かない(既存経路と完全同一の解決)。
    """
    explicit = slot.get("style")
    has_explicit = isinstance(explicit, str) and (
        explicit in ALLOWED_DIRECTIVE_STYLES or explicit in allowed_custom
    )
    if slot.get("style_overridden") and has_explicit:
        return explicit
    slot_type = slot.get("type")
    if speaker_colors:
        speaker = slot.get("speaker")
        styles = speaker_colors.get("styles") or {}
        apply_types = speaker_colors.get("apply_types") or ()
        if (
            isinstance(speaker, str)
            and isinstance(slot_type, str)
            and slot_type in apply_types
            and speaker in styles
        ):
            return sanitize_style(styles[speaker], allowed_custom)
    if isinstance(slot_type, str) and slot_type in SEMANTIC_TYPES:
        return sanitize_style(resolve_style_for_type(slot_type, type_mapping), allowed_custom)
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
    context_text: Optional[str] = None,
) -> Dict[str, Any]:
    """AI応答の1スロット分を検証し、表示に使う最終ディレクティブを返す。

    - text が空/欠落、元発話に対して不忠実(内容語の過半が元に無い)、または
      文字数上限(max_text_chars: 2行×行バジェットの重み付き文字数)超過なら
      元テキストへフォールバックする(安全弁。AI再依頼はしない)
    - type は10種へ正規化し、style はマッピング解決済みの結果として出力する(後方互換)。
      AIが有効な style を明示した場合(旧形式)はそれを尊重する
    - highlight_words は最終文言に実在する語のみ残す
    - フェーズW27: context_text(前後スロットを連結した発話)を渡すと忠実性チェックを
      その文脈に対して行う。スロット境界の断片処理(隣接スロットからの語の取り込み)を
      AIに許可したため、自スロットの発話だけと照合すると正しい修正が差し戻されるため
    """
    source_text = str(slot.get("text", ""))
    faithful_base = context_text if isinstance(context_text, str) and context_text else source_text
    raw = raw if isinstance(raw, dict) else {}

    # 自然改行(プロンプトでAIに指示する明示"\n")は保持する。連続改行・前後空白は正規化し、
    # 忠実性・文字数の検証は改行を除いた文字列で行う(改行は表示上の演出であり内容ではない)
    text = str(raw.get("text", "") or "").replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(part.strip() for part in text.split("\n") if part.strip())
    text = _PERIOD_RE.sub("", text)
    # 付属語が行頭に来る改行(「模試 / を受けられる」「担当 / していまして」)はAIが
    # 指示を守れていない位置なので採用せず、改行を落として自動折返しに任せる
    text = repair_line_breaks(text)
    flat_text = text.replace("\n", "")
    fallback = False
    # フェーズW28: 断片だけのスロット(「込みください」「模試の」等)は、AIが内容を
    # 隣接スロットへ吸収した上で drop:true を返すと表示しない(空テロップとして下流でスキップ)。
    # 誤って長い内容を消さないよう、元発話が短い場合のみ許可する
    if raw.get("drop") is True and glyph_length(source_text.replace("\n", ""), "weighted_cpl") <= 12:
        result_dropped: Dict[str, Any] = {
            "slot_id": str(slot["slot_id"]),
            "cut_id": str(slot["cut_id"]),
            "source_start_ms": int(slot["source_start_ms"]),
            "source_end_ms": int(slot["source_end_ms"]),
            "source_text": source_text,
            "text": "",
            "type": sanitize_semantic_type(raw.get("type")),
            "style": sanitize_style(resolve_style_for_type(sanitize_semantic_type(raw.get("type")), type_mapping)),
            "highlight_words": [],
            "fallback": False,
            "dropped": True,
        }
        speaker_val = slot.get("speaker")
        if isinstance(speaker_val, str) and speaker_val:
            result_dropped["speaker"] = speaker_val
        return result_dropped
    if not flat_text or not is_text_faithful(faithful_base, flat_text):
        text = source_text
        fallback = True
    elif max_text_chars is not None and glyph_length(flat_text, "weighted_cpl") > max_text_chars:
        # 文字数上限超過。ただし元発話自体が上限を超えているスロット(縦型の2行×12字設定
        # ではスロット原文の大半が該当)では、差し戻しても長さは改善せず誤字・断片だけが
        # 復活して悪化する。差し戻すのは「AI整形が元発話より明確に長い」場合
        # (=隣接取り込みを超えた膨張)のみとする(フェーズW28)
        source_len = glyph_length(source_text.replace("\n", ""), "weighted_cpl")
        if glyph_length(flat_text, "weighted_cpl") > max(max_text_chars, source_len + 8):
            text = source_text
            fallback = True

    semantic_type = sanitize_semantic_type(raw.get("type"))
    raw_style = raw.get("style")
    if isinstance(raw_style, str) and raw_style in ALLOWED_DIRECTIVE_STYLES:
        style = raw_style
    else:
        style = sanitize_style(resolve_style_for_type(semantic_type, type_mapping))
    highlight_words = sanitize_highlight_words(raw.get("highlight_words"), text)

    result: Dict[str, Any] = {
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
    # フェーズW1: build_slots が付与した話者IDを telop_directives.json へ透過する
    # (AI応答には含まれない。speaker無しスロットはフィールド自体なし=後方互換)
    speaker = slot.get("speaker")
    if isinstance(speaker, str) and speaker:
        result["speaker"] = speaker
    return result


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


# フェーズV8-6: OP(冒頭ダイジェスト)に使うスロットのAI選定(op_picks)の上限数
MAX_OP_PICKS = 5
# フェーズW(OP 0ベース再設計): OPは3〜5クリップ・10〜15秒で統一する
MIN_OP_PICKS = 3

# フェーズW: OP内での役割(先頭=開幕フック / 中盤=畳みかけ / 終盤=引き)
OP_PICK_ROLES = ("hook_open", "punch", "cliffhanger")
# フェーズW: クリップのテロップ表示方法(hook=凝縮ワードを画面に大きく / verbatim=発話テロップそのまま)
OP_PICK_DISPLAYS = ("hook", "verbatim")
# フェーズW: フックワードの核心語の色(参考ガイド§3-2: 黄=結論・肯定 / 赤=ネガ・断定・警告 / 白=中立)
OP_KEYWORD_COLORS = ("yellow", "red", "white")
# フックワードの1行の上限(全角換算。画面1/3を占める極太表示のため短く保つ)
OP_HOOK_LINE_MAX_CHARS = 10
# フェーズW4: AI生成OPタイトルの上限(全角換算。OP中央の1行表示のため短く保つ)
OP_TITLE_MAX_CHARS = 15


def sanitize_op_title(raw: Any) -> str:
    """フェーズW4: AI生成のOPタイトルの正規化。

    改行・連続空白は1スペースへ潰し、囲み記号(「」『』"")は外す。
    長すぎる(全角15文字超)場合は切り詰めず空文字を返す=不成立として
    従来のフォールバック(ユーザー入力→動画ファイル名)に任せる
    (中途半端な切り詰めはタイトルの意味が壊れるため。hook_textと同方針)。
    """
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    text = text.strip("「」『』\"'“”")
    if not text:
        return ""
    length = sum(2 if ord(ch) > 0x7F else 1 for ch in text)
    if length > OP_TITLE_MAX_CHARS * 2:
        return ""
    return text


def _sanitize_hook_text(raw: Any) -> str:
    """フックワード文言の正規化。最大2行・各行は前後空白を除去し、空行は捨てる。

    行が長すぎる(全角10文字超)場合は切り詰めず空文字を返す=フック表示不成立として
    verbatim(発話テロップ)へフォールバックさせる(中途半端な切り詰めは意味が壊れるため)。
    """
    text = str(raw or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [part.strip() for part in text.split("\n") if part.strip()][:2]
    if not lines:
        return ""
    for line in lines:
        length = sum(2 if ord(ch) > 0x7F else 1 for ch in line)
        if length > OP_HOOK_LINE_MAX_CHARS * 2:
            return ""
    return "\n".join(lines)


def sanitize_op_picks(raw: Any, slots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """AIの op_picks を検証する(フェーズV8-6 / フェーズW拡張)。

    旧形式(slot_id文字列の配列)と新形式(role/display/hook_text等を持つdictの配列)の
    両方を受け付け、正規化済みdictの配列へ揃える。実在する slot_id のみ・重複除去・
    最大 MAX_OP_PICKS 件。順序はAIの提案順(=OPでの再生順)を保持する。

    dictの正規化規則:
    - role: hook_open / punch / cliffhanger 以外は punch
    - hook_text: 最大2行・各行全角10文字以内。超過・空はフック不成立で空文字
    - display: hook / verbatim 以外は「hook_textがあればhook、なければverbatim」。
      display=hook でも hook_text が不成立なら verbatim へ落とす
    - keyword: hook_text(またはverbatim時は空文字扱い)に含まれる場合のみ採用
    - keyword_color: yellow / red / white 以外は yellow
    """
    if not isinstance(raw, list):
        return []
    valid_ids = {str(slot.get("slot_id", "")) for slot in slots if isinstance(slot, dict)}
    picks: List[Dict[str, Any]] = []
    seen: set = set()
    for entry in raw:
        if isinstance(entry, dict):
            slot_id = str(entry.get("slot_id", "") or "").strip()
            role = str(entry.get("role", "") or "")
            hook_text = _sanitize_hook_text(entry.get("hook_text"))
            display = str(entry.get("display", "") or "")
            keyword = str(entry.get("keyword", "") or "").strip()
            keyword_color = str(entry.get("keyword_color", "") or "")
        else:
            slot_id = str(entry or "").strip()
            role, hook_text, display, keyword, keyword_color = "", "", "", "", ""
        if not slot_id or slot_id not in valid_ids or slot_id in seen:
            continue
        if display not in OP_PICK_DISPLAYS:
            display = "hook" if hook_text else "verbatim"
        if display == "hook" and not hook_text:
            display = "verbatim"
        if keyword and (display != "hook" or not any(keyword in line for line in hook_text.split("\n"))):
            # keywordはフックワード内(1行内)の部分強調にのみ使う(表示に現れない語は捨てる)
            keyword = ""
        picks.append({
            "slot_id": slot_id,
            "role": role if role in OP_PICK_ROLES else "punch",
            "display": display,
            "hook_text": hook_text,
            "keyword": keyword,
            "keyword_color": keyword_color if keyword_color in OP_KEYWORD_COLORS else "yellow",
        })
        seen.add(slot_id)
        if len(picks) >= MAX_OP_PICKS:
            break
    return picks


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


def assign_slots_to_segments(
    slots: List[Dict[str, Any]],
    segments: List[Dict[str, Any]],
) -> List[List[Dict[str, Any]]]:
    """全スロットを keep_segments へ一括で割り当てる(戻り値はセグメントindex→スロットリスト)。

    第一規則は従来の select_slots_for_cut と同じ「絶対中点がセグメント内」。
    中点がどのセグメントにも入らないスロットは「重なりが最大のセグメント」へ割り当てる
    (重なりゼロ=シーン丸ごと削除等は不採用のまま)。

    中点フォールバックが必要な理由(実機FB 2026-09-03「一番最後のテキストの修正ができない・
    削除しても残り続ける」の根本原因): スロットはシーンの全範囲(削除済み単語を含む)で
    アンカーされる一方、keep_segment はシーン内の残存単語だけに縮む。シーン末尾の単語を
    半分以上削除する(動画の最後の相槌・言い残しを削る典型操作)と中点が区間外へ落ち、
    スロットがどのカットからも選ばれない=UIの編集・削除が書き出しへ一切反映されず、
    step08のSTTフォールバックが残存単語のテキストを勝手に復活させていた。
    """
    ranges = []
    for seg in segments:
        try:
            ranges.append((int(seg["start_ms"]), int(seg["end_ms"])))
        except (KeyError, TypeError, ValueError):
            ranges.append((0, 0))
    assigned: List[List[Dict[str, Any]]] = [[] for _ in ranges]
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        try:
            src_start = int(slot.get("source_start_ms", -1))
            src_end = int(slot.get("source_end_ms", -1))
        except (TypeError, ValueError):
            continue
        if src_end <= src_start:
            continue
        midpoint = (src_start + src_end) / 2
        target = None
        for index, (seg_start, seg_end) in enumerate(ranges):
            if seg_start <= midpoint < seg_end:
                target = index
                break
        if target is None:
            # 中点がどのセグメントにも入らない場合は重なり最大のセグメントへ
            best_overlap = 0
            for index, (seg_start, seg_end) in enumerate(ranges):
                overlap = min(seg_end, src_end) - max(seg_start, src_start)
                if overlap > best_overlap:
                    best_overlap = overlap
                    target = index
        if target is None:
            continue
        seg_start, seg_end = ranges[target]
        rel_start = max(0, src_start - seg_start)
        rel_end = min(seg_end, src_end) - seg_start
        if rel_end <= rel_start:
            continue
        assigned[target].append({**slot, "start_ms": rel_start, "end_ms": rel_end})
    for cut_slots in assigned:
        cut_slots.sort(key=lambda s: int(s["start_ms"]))
    return assigned


def split_manual_lines(text: str) -> Optional[List[str]]:
    """文言内の明示改行("\\n")を行リストへ分解する。改行が無ければ None。

    改行位置の意図(UI手編集・AIの自然改行)を尊重するため、明示改行がある文言は
    BudouX機械折返しを通さずこの行構成をそのまま使う。空行は除去し、
    描画側の保険上限(Remotion TELOP_ABSOLUTE_MAX_LINES=3)に合わせて最大3行に丸める。
    """
    if "\n" not in (text or ""):
        return None
    lines = [line.strip() for line in text.split("\n")]
    lines = [line for line in lines if line]
    if not lines:
        return None
    if len(lines) <= 3:
        return lines
    # 4行以上は3行目以降を結合して3行に収める(描画側の上限と揃える)
    return [lines[0], lines[1], "".join(lines[2:])]


def wrap_directive_lines(text: str, max_chars_per_line: int) -> List[str]:
    """ディレクティブ文言を最大2行に折り返す(BudouXの語境界を使う)。

    明示改行("\\n")がある文言はその行構成を正としてそのまま使う
    (UI手編集・AIの自然改行の尊重。幅超過はRemotion側の幅フィット縮小に任せる)。
    ただし付属語が行頭に来る改行(「模試 / を受けられる」「担当 / していまして」)は
    読みづらいだけなので尊重せず、自動折返しへ落とす。
    改行が無い場合は従来どおり: directed テロップは1スロット=1ページ固定のため、
    規定幅で2行に収まらない場合は行幅を広げてでも必ず1ページ(≤2行)に収める。
    """
    manual = split_manual_lines(text or "")
    if manual is not None:
        repaired = split_manual_lines(repair_line_breaks("\n".join(manual)))
        if repaired is not None and len(repaired) > 1:
            return repaired
        # 改行が全て不自然だった場合は1行に戻り、以降の自動折返しへ落ちる
    stripped = ("".join(manual) if manual is not None else (text or "")).strip()
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
    allowed_custom_styles: Any = (),
    speaker_colors: Optional[Dict[str, Any]] = None,
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
    - フェーズW1: スロットの speaker は pages/telops へ透過し、speaker_colors
      (発動条件を満たした場合のみ呼び出し側が渡す)はスタイル解決に反映される
    """
    pages: List[Dict[str, Any]] = []
    telops: List[Dict[str, Any]] = []
    for slot in slots:
        start_ms = max(0, min(int(slot.get("start_ms", 0)), duration_ms))
        end_ms = max(0, min(int(slot.get("end_ms", 0)), duration_ms))
        if end_ms <= start_ms:
            continue
        # フェーズV8-4: 漢数字→算用数字・固有名詞の正式表記を directed 経路にも適用する。
        # AI文言(sanitize後)とUI編集後の文言の両方がここを通るため、この1箇所で
        # 「五割」「一万回」等の漢数字残りを根絶できる。行ごと正規化=手動改行(V7)を壊さない
        slot_text = normalize_directed_display_text(str(slot.get("text", "")))
        lines = wrap_directive_lines(slot_text, max_chars_per_line)
        if not lines:
            continue
        page_index = len(pages)
        page_id = f"{cut_id}_p{page_index:02d}"
        # 明示改行のあるスロットは改行を保持して text へ書き戻す(UIのシーン再初期化で
        # 手動改行がtextareaへ復元され、往復しても改行位置が失われないようにする)
        text = ("\n" if "\n" in slot_text else "").join(lines)
        # highlight_words も同じ正規化を通す(「五割」指定が正規化後の「5割」に一致するように)
        raw_highlights = slot.get("highlight_words")
        if isinstance(raw_highlights, list):
            raw_highlights = [normalize_directed_display_text(str(w or "")) for w in raw_highlights]
        highlight_words = sanitize_highlight_words(raw_highlights, text)
        # フェーズU6: 定義付きカスタムスタイルID(directives/テーマ由来)はsanitizeで許可する
        style = effective_slot_style(
            slot, type_mapping, allowed_custom=allowed_custom_styles, speaker_colors=speaker_colors,
        )
        animation_in = effective_slot_animation(slot, type_mapping)
        sfx_write, sfx_value = effective_slot_sfx(slot, type_mapping)
        slot_type = slot.get("type")
        semantic_type = slot_type if isinstance(slot_type, str) and slot_type in SEMANTIC_TYPES else None
        # フェーズW1: 話者IDの透過(speaker無しスロットはフィールド自体なし=後方互換)
        raw_speaker = slot.get("speaker")
        speaker = raw_speaker if isinstance(raw_speaker, str) and raw_speaker else None

        page: Dict[str, Any] = {
            "id": page_id,
            "lines": lines,
            "style": style,
            "start_ms": start_ms,
            "end_ms": end_ms,
        }
        if semantic_type:
            page["type"] = semantic_type
        if speaker:
            page["speaker"] = speaker
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
        if speaker:
            telop["speaker"] = speaker
        if slot.get("style_overridden"):
            # UIの個別プリセット上書きを保持する(UIがシーン再初期化時に上書き状態を復元するため)
            telop["style_overridden"] = True
        if animation_in:
            telop["animation_in"] = animation_in
            if isinstance(slot.get("animation_in"), str) and slot["animation_in"] in ANIMATION_IN_TYPES:
                # UIピッカーの個別上書き由来であることを保持する(シーン再初期化時の復元用)
                telop["animation_overridden"] = True
        # シーン検品で明示指定された映像演出を再初期化時に復元するため、
        # composition telopへ値と上書きフラグを透過する。自動選定はここへ書かない。
        video_effect = slot.get("video_effect")
        if isinstance(video_effect, str) and video_effect in {"none", "pinch", "zoom"}:
            telop["video_effect"] = video_effect
            telop["video_effect_overridden"] = True
        if sfx_write:
            telop["sfx"] = sfx_value
        if highlight_words:
            telop["highlight_words"] = highlight_words
        telops.append(telop)
    return pages, telops


# フェーズW26: 縦型のバンド系スタイル(黄帯CTA・赤帯)の連発抑制。
# Fable v5の検証で「帯は要所で1回だから効く」と確認済み。CTAスロットが連続すると
# 画面が帯だらけになるため、直前の帯から一定間隔未満の帯は標準ゴシックへ落とす。
VERTICAL_BAND_STYLES = ("ad_highlight_band", "ad_urgent_band")
VERTICAL_BAND_FALLBACK_STYLE = "ad_gothic_impact"
VERTICAL_BAND_MIN_GAP_MS = 15000


def moderate_vertical_band_styles(
    cuts: List[Dict[str, Any]],
    voice_cuts: List[Dict[str, Any]],
    min_gap_ms: int = VERTICAL_BAND_MIN_GAP_MS,
) -> int:
    """縦型のバンド系テロップを時系列で見て、間隔が近すぎる帯を標準スタイルへ落とす。

    - ユーザーの個別上書き(style_overridden)は常に尊重して demote しない
      (上書き帯も「直前の帯」として次の判定基準になる)
    - timeline pages(cuts[].telop.pages)と voice telops は同じIDを持つため両方demoteする

    Returns:
        demoteしたテロップ数。
    """
    starts = {cut.get("cut_id"): int(cut.get("timeline", {}).get("start_ms", 0)) for cut in cuts}
    pages_by_id: Dict[str, Dict[str, Any]] = {}
    for cut in cuts:
        for page in (cut.get("telop", {}).get("pages") or []):
            if page.get("id"):
                pages_by_id[str(page["id"])] = page

    events: List[Tuple[int, Dict[str, Any]]] = []
    for vcut in voice_cuts:
        base = starts.get(vcut.get("id"))
        if base is None:
            continue
        for telop in vcut.get("telops") or []:
            if telop.get("style") in VERTICAL_BAND_STYLES:
                try:
                    abs_ms = base + int(float(telop.get("start", 0)) * 1000)
                except (TypeError, ValueError):
                    continue
                events.append((abs_ms, telop))
    events.sort(key=lambda item: item[0])

    demoted = 0
    last_band_ms: Optional[int] = None
    for abs_ms, telop in events:
        if telop.get("style_overridden"):
            last_band_ms = abs_ms
            continue
        if last_band_ms is not None and abs_ms - last_band_ms < min_gap_ms:
            telop["style"] = VERTICAL_BAND_FALLBACK_STYLE
            page = pages_by_id.get(str(telop.get("id", "")))
            if page is not None:
                page["style"] = VERTICAL_BAND_FALLBACK_STYLE
            demoted += 1
        else:
            last_band_ms = abs_ms
    return demoted


# フェーズW27: 縦型ショートのアクセントスタイル自動割当(特大・縦書き・斜め)。
# 「表現を増やしたい(縦文字・斜め文字・サイズのインパクト)」への対応。
# 短い決め語だけを対象に、間隔を空けて散らす(連発すると効かなくなるため)。
VERTICAL_ACCENT_SOURCE_STYLES = ("ad_gothic_impact", "ad_mincho_impact")
VERTICAL_ACCENT_TYPES = ("emphasis", "punchline", "hype", "surprise", "quote", "harsh")
VERTICAL_ACCENT_MIN_GAP_MS = 12000
# 文字数(改行除く)→アクセントスタイルとアニメの対応。
# 短文(8文字以下)はtypeの性格で分ける: 勢い系=特大 / しみじみ決め系=縦書き明朝。
# 中文(9〜18文字)は斜め(回転は2行ブロックでも成立する)。19文字以上は対象外。
_ACCENT_SHORT_MAX_CHARS = 8
_ACCENT_SLANT_MAX_CHARS = 18
_ACCENT_QUIET_TYPES = ("quote", "punchline")
_ACCENT_ANIMATIONS = {
    "ad_mega_impact": "slam",
    "ad_vertical_mincho": "zoom",
    "ad_slant_impact": "bounce_left",
}


def _accent_style_for_text(flat_text: str, semantic_type: str) -> Optional[str]:
    """文字数とtypeの性格からアクセントスタイルを決める(長文は対象外=None)。"""
    length = len(flat_text)
    if length == 0:
        return None
    if length <= _ACCENT_SHORT_MAX_CHARS:
        return "ad_vertical_mincho" if semantic_type in _ACCENT_QUIET_TYPES else "ad_mega_impact"
    if length <= _ACCENT_SLANT_MAX_CHARS:
        return "ad_slant_impact"
    return None


def assign_vertical_accent_styles(
    cuts: List[Dict[str, Any]],
    voice_cuts: List[Dict[str, Any]],
    min_gap_ms: int = VERTICAL_ACCENT_MIN_GAP_MS,
) -> int:
    """縦型ショートの短い決め語へアクセントスタイル(特大・縦書き・斜め)を散らす。

    対象: type が強調系(VERTICAL_ACCENT_TYPES)かつ標準スタイル(ゴシック/明朝)のテロップで、
    改行を除いた文字数が18以下のもの。文字数とtypeの性格でスタイルを選ぶ:
    - 8文字以下×勢い系(emphasis/hype/surprise/harsh) → ad_mega_impact(特大)
    - 8文字以下×決め系(quote/punchline) → ad_vertical_mincho(縦書き明朝)
    - 9〜18文字 → ad_slant_impact(斜め)

    直前のアクセントから min_gap_ms 未満は割り当てない(連発防止)。
    ユーザーの個別上書き(style_overridden)は対象外。
    timeline pages と voice telops は同じIDを持つため両方書き換え、
    アニメーションもアクセントに合う種類へ上書きする。

    Returns:
        割り当てたテロップ数。
    """
    starts = {cut.get("cut_id"): int(cut.get("timeline", {}).get("start_ms", 0)) for cut in cuts}
    pages_by_id: Dict[str, Dict[str, Any]] = {}
    for cut in cuts:
        for page in (cut.get("telop", {}).get("pages") or []):
            if page.get("id"):
                pages_by_id[str(page["id"])] = page

    events: List[Tuple[int, Dict[str, Any]]] = []
    for vcut in voice_cuts:
        base = starts.get(vcut.get("id"))
        if base is None:
            continue
        for telop in vcut.get("telops") or []:
            try:
                abs_ms = base + int(float(telop.get("start", 0)) * 1000)
            except (TypeError, ValueError):
                continue
            events.append((abs_ms, telop))
    events.sort(key=lambda item: item[0])

    assigned = 0
    last_accent_ms: Optional[int] = None
    for abs_ms, telop in events:
        if telop.get("style_overridden"):
            continue
        if telop.get("style") not in VERTICAL_ACCENT_SOURCE_STYLES:
            continue
        if telop.get("type") not in VERTICAL_ACCENT_TYPES:
            continue
        flat_text = str(telop.get("text", "")).replace("\n", "")
        accent = _accent_style_for_text(flat_text, str(telop.get("type", "")))
        if accent is None:
            continue
        if last_accent_ms is not None and abs_ms - last_accent_ms < min_gap_ms:
            continue
        telop["style"] = accent
        telop["animation_in"] = _ACCENT_ANIMATIONS[accent]
        page = pages_by_id.get(str(telop.get("id", "")))
        if page is not None:
            page["style"] = accent
            page["animation_in"] = _ACCENT_ANIMATIONS[accent]
        last_accent_ms = abs_ms
        assigned += 1
    return assigned


# フェーズW31: 標準テロップのアニメーションローテーション。
# 全テロップが bounce_left(震えスライド)だと目が疲れる(2026-08-22フィードバック)ため、
# 地の文(default/reply型×標準ゴシック)はシンプル系のプールから出現順に順繰りで割り当て、
# 控えめかつ単調にならないリズムを作る。強調系(surprise/harsh/quote等)と
# アクセントスタイル(特大・斜め・縦書き)は従来の強いアニメのまま。
VERTICAL_STANDARD_ANIMATION_POOL = ("slide_up", "fade", "drop_settle", "wipe_up")
VERTICAL_STANDARD_ROTATE_TYPES = ("default", "reply")


def assign_vertical_animation_variety(
    cuts: List[Dict[str, Any]],
    voice_cuts: List[Dict[str, Any]],
) -> int:
    """縦型の地の文テロップへシンプル系アニメを出現順にローテーション割当する。

    対象: type が default/reply かつ標準ゴシック(ad_gothic_impact)のテロップ。
    ユーザーの個別上書き(animation_overridden / style_overridden)は対象外。
    assign_vertical_accent_styles の後に呼ぶ(アクセント昇格済みのテロップは
    スタイルが変わっているため自然に対象から外れる)。

    Returns:
        割り当てたテロップ数。
    """
    starts = {cut.get("cut_id"): int(cut.get("timeline", {}).get("start_ms", 0)) for cut in cuts}
    pages_by_id: Dict[str, Dict[str, Any]] = {}
    for cut in cuts:
        for page in (cut.get("telop", {}).get("pages") or []):
            if page.get("id"):
                pages_by_id[str(page["id"])] = page

    events: List[Tuple[int, Dict[str, Any]]] = []
    for vcut in voice_cuts:
        base = starts.get(vcut.get("id"))
        if base is None:
            continue
        for telop in vcut.get("telops") or []:
            try:
                abs_ms = base + int(float(telop.get("start", 0)) * 1000)
            except (TypeError, ValueError):
                continue
            events.append((abs_ms, telop))
    events.sort(key=lambda item: item[0])

    assigned = 0
    for abs_ms, telop in events:
        if telop.get("style_overridden") or telop.get("animation_overridden"):
            continue
        if telop.get("style") != "ad_gothic_impact":
            continue
        if telop.get("type", "default") not in VERTICAL_STANDARD_ROTATE_TYPES:
            continue
        animation = VERTICAL_STANDARD_ANIMATION_POOL[assigned % len(VERTICAL_STANDARD_ANIMATION_POOL)]
        telop["animation_in"] = animation
        page = pages_by_id.get(str(telop.get("id", "")))
        if page is not None:
            page["animation_in"] = animation
        assigned += 1
    return assigned


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
            return seg["timeline_start_ms"] + (
                source_ms - seg["source_start_ms"]
            ) / float(seg.get("speed", 1) or 1)
    return None


# フェーズV8-3: profile_card の同一人物判定で除去する末尾の敬称
_PROFILE_HONORIFIC_RE = re.compile(r"(?:さん|くん|ちゃん|様|氏|先生)$")


def profile_dedup_key(text: Any) -> str:
    """profile_card の同一人物判定キー(空白除去+末尾敬称の除去)。"""
    key = re.sub(r"\s+", "", str(text or ""))
    return _PROFILE_HONORIFIC_RE.sub("", key)


def cta_slot_timeline_intervals(
    directives: Dict[str, Any],
    segments: List[Dict[str, int]],
    total_duration_ms: int,
) -> List[Tuple[int, int]]:
    """フェーズW3: type=cta のスロットのタイムライン区間一覧(開始昇順)。

    CTAテロップが表示されている区間 = cta_banner を重ねてはいけない区間。
    keep_segments と実際に交差する部分だけを写像する(map_source_ms_to_timeline は
    カット済み区間を次セグメント先頭へスナップするため、トリムで消えたスロットが
    幻の回避区間を作らないよう交差ベースで計算する)。
    """
    intervals: List[Tuple[int, int]] = []
    for slot in directives.get("slots") or []:
        if not isinstance(slot, dict) or str(slot.get("type", "")) != "cta":
            continue
        source_start = int(slot.get("source_start_ms", -1))
        source_end = int(slot.get("source_end_ms", -1))
        if source_end <= source_start:
            continue
        for seg in segments:
            overlap_start = max(source_start, seg["source_start_ms"])
            overlap_end = min(source_end, seg["source_end_ms"])
            if overlap_end <= overlap_start:
                continue
            speed = float(seg.get("speed", 1) or 1)
            start_ms = seg["timeline_start_ms"] + (overlap_start - seg["source_start_ms"]) / speed
            end_ms = min(total_duration_ms, start_ms + (overlap_end - overlap_start) / speed)
            if start_ms < total_duration_ms and end_ms > start_ms:
                intervals.append((start_ms, end_ms))
    intervals.sort()
    return intervals


def resolve_cta_banner_window(
    anchor_start_ms: int,
    avoid_intervals: List[Tuple[int, int]],
    total_duration_ms: int,
) -> Optional[Tuple[int, int]]:
    """フェーズW3: cta_banner の表示区間を、回避区間(CTAテロップ・既出バナー)と
    重ならない位置へ解決する。

    アンカー位置から既定尺で開始し、回避区間と重なる間は「その区間の終端+マージン」へ
    後ろ送りする(前へは動かさない=発話より先にバナーが出るのを防ぐ)。
    総尺内に CTA_BANNER_MIN_DURATION_MS を確保できなければ None(表示しない)。
    """
    duration_ms = OVERLAY_DEFAULT_DURATION_MS["cta_banner"]
    start_ms = anchor_start_ms
    # 回避区間は高々スロット数個。後ろ送りは単調増加なので必ず停止する
    for _ in range(len(avoid_intervals) + 1):
        conflict = next(
            (
                iv for iv in avoid_intervals
                if iv[0] < min(start_ms + duration_ms, total_duration_ms) and start_ms < iv[1]
            ),
            None,
        )
        if conflict is None:
            break
        start_ms = conflict[1] + CTA_BANNER_AVOID_MARGIN_MS
    end_ms = min(total_duration_ms, start_ms + duration_ms)
    if end_ms - start_ms < CTA_BANNER_MIN_DURATION_MS:
        return None
    return (start_ms, end_ms)


def build_directed_overlays(
    directives: Dict[str, Any],
    segments: List[Dict[str, int]],
    total_duration_ms: int,
    overlay_title: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """telop_directives.json のチャプター/オーバーレイ提案を timeline.overlays へ変換する。

    Args:
        segments: [{"source_start_ms","source_end_ms","timeline_start_ms"}] (時系列順)
        total_duration_ms: 編集後タイムラインの総尺(ms)
        overlay_title: フェーズU7のシーンタイトル設定 {"enabled": bool, "style": str}。
            None は既定(有効・box_accent=現行デザイン)= U7以前と同じ出力(後方互換)。
            enabled=False なら chapter_title を一切生成しない。
    """
    overlays: List[Dict[str, Any]] = []
    title_cfg = overlay_title if isinstance(overlay_title, dict) else {}
    title_enabled = title_cfg.get("enabled") is not False
    title_style = title_cfg.get("style")

    # チャプター: 各章は次章の開始まで表示し、全体でタイムラインをカバーする
    chapters = [
        ch for ch in (directives.get("chapters") or [])
        if isinstance(ch, dict) and str(ch.get("title", "")).strip()
    ] if title_enabled else []
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
        item: Dict[str, Any] = {
            "id": str(chapter.get("id") or f"chapter_{i + 1:02d}"),
            "type": "chapter_title",
            "start_ms": effective_start,
            "end_ms": end_ms,
            "text": str(chapter["title"]).strip(),
            "position": "top_left",
        }
        # フェーズU7: 描画パターンID。box_accent(既定)は書かない=既存compositionと同形
        if isinstance(title_style, str) and title_style and title_style != "box_accent":
            item["style"] = title_style
        overlays.append(item)

    # profile_card / list_stack / cta_banner: アンカー位置から既定時間で表示する
    # profile_card は同一人物につき最初の1回だけ表示する
    # (AIがチャンクごとに同じ人物紹介を繰り返し提案するため。ユーザーFB 2026-07-06)
    # フェーズV8-3: 「空白除去textの完全一致」では敬称違い(「笠井俊哉くん」と「笠井俊哉」)が
    # すり抜けて同一人物が2回出ていた(実データ 20260707_004339 で確認)。キーを
    # 空白+末尾敬称の除去に強化し、さらに既出キーとの包含関係も同一人物と見なす
    # フェーズW3: cta_banner はCTAテロップ(type=ctaスロット)と同時刻に出さない
    # (同じ文言の黄色ボックスが2枚重なる「バナー2重」の実データFB 20260707_194708)。
    # 既に置いたバナー同士も重ねない
    cta_avoid_intervals = cta_slot_timeline_intervals(directives, segments, total_duration_ms)
    seen_profile_keys: set = set()
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
        if overlay_type == "cta_banner":
            window = resolve_cta_banner_window(start_ms, cta_avoid_intervals, total_duration_ms)
            if window is None:
                continue
            start_ms, end_ms = window
            cta_avoid_intervals.append(window)
            cta_avoid_intervals.sort()
        if overlay_type == "profile_card":
            profile_key = profile_dedup_key(overlay.get("text", ""))
            if not profile_key or any(
                profile_key in seen or seen in profile_key for seen in seen_profile_keys
            ):
                continue
            seen_profile_keys.add(profile_key)
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

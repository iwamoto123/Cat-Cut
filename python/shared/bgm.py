"""フェーズU9: BGMトラック。

UI(desktop)が runs/<run>/bgm/bgm.json にBGMクリップ設定を保存し、
step08 がそれを composition.json の timeline.bgm へ転写する。

bgm.json の形式(配列。start/endはタイムラインms基準):
    [{"id", "file", "start_ms", "end_ms", "volume", "fade_in_ms", "fade_out_ms"}]

- file は runs/<run>/bgm/ 内のファイル名(相対)。転写時に絶対パスへ解決する
  (render-cli が segments と同じ経路でHTTP配信できるようにするため)。
- bgm.json が無い・空・全滅の場合は timeline.bgm を書かない=既存compositionと同形(後方互換)。
- OPがある場合もBGMの開始はタイムライン全体基準のまま(OP含む先頭=0起点)なので
  オフセット調整はしない(単純に転写する)。
"""

import json
import os

# 追加時の既定音量。100%を既定としユーザーが微調整する運用(実機FB 2026-09-03)。desktop/remotion側の既定と同値。
BGM_DEFAULT_VOLUME = 1.0


def _clamp(value, low, high):
    return max(low, min(high, value))


def normalize_bgm_clips(raw, bgm_dir, total_duration_ms=None):
    """bgm.json の未検証データを timeline.bgm 形式のクリップ一覧へ正規化する。

    - file は bgm_dir からの相対名として絶対パスへ解決し、実在しないファイルは除外
      (音源が消えたクリップで書き出しを失敗させないための防御)
    - 区間ゼロ・数値でない start/end は除外
    - volume は 0〜1、フェードは 0〜クリップ長 へ丸める
    - total_duration_ms 指定時は end をタイムライン総尺へクランプ
    - V6-5: 配列順=UIのレーン順の正本のため、start_ms でのソートはせず入力順を保つ
      (ミックス結果は順不同なので書き出しには影響しない)
    """
    if not isinstance(raw, list):
        return []
    clips = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            continue
        file_name = entry.get("file")
        if not isinstance(file_name, str) or not file_name:
            continue
        # 絶対パスが直接書かれていても受け付ける(手書きbgm.json向け)
        file_path = file_name if os.path.isabs(file_name) else os.path.join(bgm_dir, file_name)
        file_path = os.path.abspath(file_path)
        if not os.path.exists(file_path):
            continue
        try:
            start_ms = int(round(float(entry.get("start_ms"))))
            end_ms = int(round(float(entry.get("end_ms"))))
        except (TypeError, ValueError):
            continue
        start_ms = max(0, start_ms)
        if total_duration_ms is not None:
            end_ms = min(end_ms, int(total_duration_ms))
        if end_ms <= start_ms:
            continue
        duration_ms = end_ms - start_ms
        try:
            volume = _clamp(float(entry.get("volume")), 0.0, 1.0)
        except (TypeError, ValueError):
            volume = BGM_DEFAULT_VOLUME
        try:
            fade_in_ms = int(_clamp(int(round(float(entry.get("fade_in_ms", 0) or 0))), 0, duration_ms))
        except (TypeError, ValueError):
            fade_in_ms = 0
        try:
            fade_out_ms = int(_clamp(int(round(float(entry.get("fade_out_ms", 0) or 0))), 0, duration_ms))
        except (TypeError, ValueError):
            fade_out_ms = 0
        clip_id = entry.get("id")
        clips.append({
            "id": clip_id if isinstance(clip_id, str) and clip_id else f"bgm_{index + 1}",
            "file": file_path,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "volume": volume,
            "fade_in_ms": fade_in_ms,
            "fade_out_ms": fade_out_ms,
        })
    return clips


def load_bgm_track(run_dir, total_duration_ms=None):
    """runs/<run>/bgm/bgm.json を読み、timeline.bgm 形式のクリップ一覧を返す。

    ファイルなし・壊れたJSON・有効クリップゼロは [] (呼び出し側はキー自体を書かない)。
    """
    bgm_dir = os.path.join(run_dir, "bgm")
    path = os.path.join(bgm_dir, "bgm.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    return normalize_bgm_clips(raw, bgm_dir, total_duration_ms=total_duration_ms)

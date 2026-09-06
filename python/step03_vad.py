"""Step 3: VAD - Silero VAD による高精度音声区間検出。

PyTorch + Silero VAD モデルを使用。FFmpeg silencedetect より高精度に
音声/非音声を判別する（ML ベースの意味的判別 vs エネルギー閾値）。

参考実装: Silero VAD による音声区間検出パイプライン

Usage:
    python step03_vad.py \
        --audio ../runs/{run}/step01_preprocess/audio.wav \
        --stt ../runs/{run}/step02_stt/stt_result.json \
        --output ../runs/{run}/step03_vad
"""

import argparse
import json
import os
from typing import List, Tuple

import torch

SAMPLING_RATE = 16_000
_SILERO_MODEL = None
_SILERO_UTILS = None
_SILERO_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def run_step(
    audio_path: str,
    stt_result_path: str,
    output_dir: str,
    config: dict = None,
) -> dict:
    """Silero VAD で音声区間を検出し、無音区間を特定する。

    Args:
        audio_path: 音声ファイルパス (WAV 16kHz mono)
        stt_result_path: Step 2 の STT 結果 JSON パス
        output_dir: 出力ディレクトリ
        config: パイプライン設定
            - vad_threshold: 発話確率閾値 (default: 0.5)
            - vad_min_speech_sec: 最小発話長 (default: 0.25)
            - vad_min_silence_sec: 最小無音長 (default: 0.3)
            - vad_speech_pad_sec: 発話前後パディング (default: 0.1)
            - vad_window_ms: 分析ウィンドウ (default: 64)

    Returns:
        {"speech_segments": [...], "silence_regions": [...]}
    """
    os.makedirs(output_dir, exist_ok=True)
    config = config or {}

    print(f"[Step 3] VAD (Silero): {audio_path}")

    # STT 結果読み込み (speech_confidence 計算用)
    with open(stt_result_path, "r", encoding="utf-8") as f:
        stt_result = json.load(f)

    # Silero VAD モデルロード
    model, utils = _load_silero_model()
    (
        get_speech_timestamps,
        _save_audio,
        read_audio,
        _vad_iterator,
        _collect_chunks,
    ) = utils

    # 音声読み込み
    # silero-vad の read_audio は torchaudio のバージョンによって torchcodec を
    # 要求することがある（Intel Mac には提供が無い）ため、失敗時は ffmpeg で読む
    try:
        waveform = read_audio(str(audio_path), sampling_rate=SAMPLING_RATE)
    except Exception as e:
        print(f"  read_audio failed ({type(e).__name__}); falling back to ffmpeg decode")
        waveform = _read_audio_ffmpeg(str(audio_path), SAMPLING_RATE)
    audio_duration_ms = int(waveform.shape[-1] / SAMPLING_RATE * 1000)

    # VAD パラメータ
    threshold = config.get("vad_threshold", 0.5)
    min_speech_ms = int(config.get("vad_min_speech_sec", 0.25) * 1000)
    min_silence_ms = int(config.get("vad_min_silence_sec", 0.3) * 1000)
    speech_pad_ms = int(config.get("vad_speech_pad_sec", 0.1) * 1000)
    window_ms = config.get("vad_window_ms", 64)
    window_samples = max(256, int(window_ms * SAMPLING_RATE / 1000))

    # Silero VAD 実行
    with torch.no_grad():
        speech_timestamps = get_speech_timestamps(
            waveform.to(_SILERO_DEVICE),
            model,
            sampling_rate=SAMPLING_RATE,
            threshold=threshold,
            min_speech_duration_ms=min_speech_ms,
            min_silence_duration_ms=min_silence_ms,
            speech_pad_ms=speech_pad_ms,
            window_size_samples=window_samples,
            return_seconds=False,
        )

    # sample index → ms 変換
    speech_segments = []
    for idx, ts in enumerate(speech_timestamps):
        start_samples = ts.get("start", 0)
        end_samples = ts.get("end", 0)
        if end_samples <= start_samples:
            continue
        start_ms = int(start_samples / SAMPLING_RATE * 1000)
        end_ms = int(end_samples / SAMPLING_RATE * 1000)
        speech_segments.append({
            "start_ms": start_ms,
            "end_ms": end_ms,
            "duration_ms": end_ms - start_ms,
            "confidence": _speech_confidence(
                start_ms, end_ms, stt_result.get("words", [])
            ),
        })

    # 無音区間: speech_segments の隙間
    min_silence_for_cut = config.get("vad_min_silence_sec", 0.3)
    silence_regions = _segments_to_silence_regions(
        speech_segments, audio_duration_ms, min_silence_for_cut
    )

    result = {
        "speech_segments": speech_segments,
        "silence_regions": silence_regions,
        "audio_duration_ms": audio_duration_ms,
        "stats": {
            "total_silence_ms": sum(s["duration_ms"] for s in silence_regions),
            "total_speech_ms": sum(s["duration_ms"] for s in speech_segments),
            "long_silence_count": sum(1 for s in silence_regions if s.get("is_long")),
            "silence_ratio": round(
                sum(s["duration_ms"] for s in silence_regions) / max(audio_duration_ms, 1),
                3,
            ),
        },
    }

    print(f"  speech segments: {len(speech_segments)}")
    print(f"  silence regions: {len(silence_regions)}")
    print(f"  long silences (>=2s): {result['stats']['long_silence_count']}")
    print(f"  silence ratio: {result['stats']['silence_ratio']:.1%}")

    # 結果保存
    output_path = os.path.join(output_dir, "vad_result.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"[Step 3] Done: {output_path}")
    return result


def _read_audio_ffmpeg(audio_path: str, sampling_rate: int) -> "torch.Tensor":
    """ffmpeg で音声をデコードして 1D float32 テンソルを返す（read_audio の代替）。"""
    import subprocess

    import numpy as np

    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", audio_path,
        "-f", "f32le", "-acodec", "pcm_f32le",
        "-ac", "1", "-ar", str(sampling_rate),
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=True)
    samples = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    return torch.from_numpy(samples)


def _load_silero_model():
    """Silero VAD モデルをロード (シングルトン)。"""
    global _SILERO_MODEL, _SILERO_UTILS
    if _SILERO_MODEL is None or _SILERO_UTILS is None:
        print("  Loading Silero VAD model...")
        try:
            model, utils = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                trust_repo=True,
            )
        except Exception as e:
            # torch.hub が github 取得に失敗した場合、pip 版 silero-vad で代替
            print(f"  torch.hub failed ({type(e).__name__}); falling back to pip silero-vad")
            from silero_vad import (
                load_silero_vad,
                get_speech_timestamps,
                read_audio,
                save_audio,
                VADIterator,
                collect_chunks,
            )
            model = load_silero_vad()
            utils = (get_speech_timestamps, save_audio, read_audio, VADIterator, collect_chunks)
        model.to(_SILERO_DEVICE)
        model.eval()
        _SILERO_MODEL = model
        _SILERO_UTILS = utils
        print(f"  Model loaded (device: {_SILERO_DEVICE})")
    return _SILERO_MODEL, _SILERO_UTILS


def _segments_to_silence_regions(
    speech_segments: list,
    audio_duration_ms: int,
    min_silence_sec: float,
    epsilon_ms: int = 50,
) -> list:
    """speech_segments の隙間から silence_regions を構築。"""
    if not speech_segments:
        if audio_duration_ms > 0:
            return [{
                "start_ms": 0,
                "end_ms": audio_duration_ms,
                "duration_ms": audio_duration_ms,
                "type": "silence",
                "is_long": audio_duration_ms >= 2000,
            }]
        return []

    sorted_segs = sorted(speech_segments, key=lambda s: s["start_ms"])
    regions = []
    min_silence_ms = int(min_silence_sec * 1000)

    # 冒頭の無音
    first_start = sorted_segs[0]["start_ms"]
    if first_start > epsilon_ms:
        dur = first_start
        regions.append({
            "start_ms": 0,
            "end_ms": first_start,
            "duration_ms": dur,
            "type": "silence" if dur >= 3000 else "speech_pause",
            "is_long": dur >= 2000,
        })

    # セグメント間の隙間
    for i in range(len(sorted_segs) - 1):
        gap_start = sorted_segs[i]["end_ms"]
        gap_end = sorted_segs[i + 1]["start_ms"]
        gap = gap_end - gap_start
        if gap >= min_silence_ms:
            regions.append({
                "start_ms": gap_start,
                "end_ms": gap_end,
                "duration_ms": gap,
                "type": "silence" if gap >= 3000 else "speech_pause",
                "is_long": gap >= 2000,
            })

    # 末尾の無音
    last_end = sorted_segs[-1]["end_ms"]
    if audio_duration_ms - last_end > epsilon_ms:
        dur = audio_duration_ms - last_end
        regions.append({
            "start_ms": last_end,
            "end_ms": audio_duration_ms,
            "duration_ms": dur,
            "type": "silence" if dur >= 3000 else "speech_pause",
            "is_long": dur >= 2000,
        })

    return regions


def _speech_confidence(start_ms: int, end_ms: int, words: list) -> float:
    """指定区間内の STT words の平均 confidence を計算。"""
    overlapping = [
        w for w in words
        if w.get("end_ms", 0) > start_ms and w.get("start_ms", 0) < end_ms
    ]
    if not overlapping:
        return 0.5
    confidences = [w.get("confidence", 0.5) for w in overlapping]
    return round(sum(confidences) / len(confidences), 3)


def main():
    parser = argparse.ArgumentParser(description="Step 3: VAD (Silero)")
    parser.add_argument("--audio", required=True, help="Input audio path")
    parser.add_argument("--stt", required=True, help="STT result JSON path")
    parser.add_argument("--output", required=True, help="Output directory")
    args = parser.parse_args()

    run_step(args.audio, args.stt, args.output)


if __name__ == "__main__":
    main()

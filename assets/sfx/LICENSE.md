# 効果音(SFX)のライセンス

このフォルダの効果音(`*.wav`)は、すべて本リポジトリの
`python/tools/generate_sfx.py` が ffmpeg の合成音源(`aevalsrc`)で
**自家生成**したものです。

- 出典: 自家生成(外部音源・外部サイトからのダウンロードは一切含まない)
- ライセンス: 制限なし(商用利用・改変・再配布可)
- 再生成方法: `.venv/bin/python python/tools/generate_sfx.py`
  (同スクリプトが `remotion/public/sfx/` にも同じwavをコピーする)

| ファイル | 音 | 主な用途 |
|---|---|---|
| don.wav | ドン(低音インパクト) | 強調・煽り系テロップ(pop_big) |
| shakin.wav | シャキーン(高周波スイープ) | 名言・辛辣系テロップ(slide_left) |
| pon.wav | ポン(短いポップ) | 質問系テロップ(slide_up) |
| jan.wav | ジャン(和音バースト) | 要点・オチ・CTA系テロップ(zoom) |
| hyu.wav | ヒュッ(風切り) | 汎用 |
| teen.wav | チーン(ベル系・長い余韻) | 映像ギミックpinch=辛辣シーンの引き締め(フェーズW2) |

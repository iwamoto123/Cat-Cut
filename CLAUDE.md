# Cat-Cut 開発メモ

Cat-Cut はローカルのデスクトップUIでトーク動画のカット、テロップ、フォント調整、MP4書き出しを行うアプリです。

## 起動

```bash
cd desktop
nodenv exec npm run dev
```

## 構成

| ディレクトリ | 役割 |
|-------------|------|
| `desktop/` | Electron + React のアプリUI |
| `python/` | STT、VAD、カット案、テロップ抽出/反映 |
| `remotion/` | MP4レンダリング |
| `templates/` | 縦横動画設定、辞書、テロッププリセット |
| `runs/` | 実行ごとの中間成果物 |

## パイプライン

| # | ステップ | 説明 |
|---|---------|------|
| 1 | preprocess | FFmpeg音声抽出 + 縦横自動判定 |
| 2 | stt | 文字起こし |
| 2b | transcript_correct | 辞書ベースのSTT補正 |
| 3 | vad | 無音区間検出 |
| 4 | filler_detect | フィラー検出 |
| 7 | cut_proposal | カット提案 |
| 8 | composition | テロップ生成 + セグメント分割 |
| 9 | telop review | UIでテロップとフォントを確認 |
| 10 | render | RemotionでMP4書き出し |

## 注意

- Electron main/preload を変更したらアプリを再起動する。
- 書き出し失敗時は `runs/<run>/pipeline.log` を見る。
- Remotion の composition id は `CatCut`。
- 保存先未指定時の出力は `runs/<run>/output/final.mp4`。

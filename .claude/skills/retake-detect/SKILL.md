# Skill: retake-detect

トーク動画の文字起こしから「言い直し」を検出する。

## 入力

`stt_result.json` の sentences を読み込み、以下を判断する:
- 話者が同じ内容を言い直した箇所 (失敗→やり直し)
- 言い詰まって最初から言い直した箇所
- 明らかに同じフレーズを2回以上言っている箇所

## 判断基準

言い直しと判定するもの:
- 同一フレーズの繰り返し (前の方が途中で切れている)
- 「あ、違う」「もう一回」等の修正意図が見える発話
- 直前の文と内容がほぼ同じで、表現が少し異なる

言い直しでないもの:
- 意図的な繰り返し (強調目的)
- 別の文脈で同じ単語を使用
- リスト形式の列挙

## keep の判定

- 通常は retry (言い直した方) を採用
- 言い直しが途中で切れている場合は original を採用

## 出力形式

sentences を読んだ後、以下の JSON を `retakes.json` として保存する:

```json
{
  "retakes": [
    {
      "original_sentence_ids": ["sent_0003", "sent_0004"],
      "retry_sentence_ids": ["sent_0005", "sent_0006"],
      "keep": "retry",
      "reason": "同じ内容の言い直し。retryの方が流暢"
    }
  ]
}
```

言い直しがない場合は retakes を空配列にする。

## 手順

1. `stt_result.json` を Read で読む
2. sentences 一覧を確認
3. 言い直しを判断
4. 結果を `retakes.json` として Write で保存

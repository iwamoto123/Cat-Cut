import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * フェーズU1(プレビュー忠実化): remotion側のpureロジックをdesktopへコピーした共有モジュールの
 * ファイル一致テスト。telopTypography.test.ts と同じ方式で、
 * 「プレビューと書き出しMP4で同じ計算結果になる」ことをバイト一致で保証する。
 */

const SHARED_COPIES = [
  "telopPosition.ts", // 改善17: 手動配置/矩形クランプ
  "telopLayout.ts", // U1-3: 縦位置(telop_y+y_offset+クランプ)と折返しレイアウト
  "overlayItems.ts", // U1-5: overlays の型・正規化・表示区間判定
  "overlayStyles.ts", // U1-5: オーバーレイ4種+captionの見た目定義(配置・配色・フォント)
  "telopAnimation.ts", // U1-6: 登場アニメの種類・長さの解決
  "telopHighlight.ts", // U1-2: highlight_words の区間分割
  "telopSfx.ts", // U1-6: 効果音IDの解決と最小間隔ガード
  "telopGlow.ts", // U6: 光彩(グロウ)のCSS filter生成
  "bgmAudio.ts", // U9: BGMトラックの正規化とフェード音量カーブ
  "opTimeline.ts", // V3: OPの正規化とフェーズ(タイミング)計算(プレビューのOP再生近似が共有する)
  "imageOverlay.ts", // V4: 画像挿入トラックの正規化と配置(中心座標+scale)計算
  "videoEffects.ts", // W2: シーン映像ギミック(pinch/zoom)の正規化とtransform/filter計算
  "videoFraming.ts", // W9: 映像フレーミング(変形・クロップ)の正規化とcropRect/videoRect計算
  "telopLineBreak.ts", // W22: 行頭に付属語(助詞・助動詞)を置かない改行ルール
  "adSafeZone.ts", // W24 Phase A: 縦型広告セーフゾーンのテロップ配置(顔回避)とcut単位telop_y解決
  "telopTypewriter.ts", // W24 Phase B: typewriterのgrapheme分割と出現タイミング(本描画とCSS近似の共有規則)
  "punchIn.ts", // W26: カット単位パンチイン(交互ズーム)の正規化とtransform計算
];

for (const fileName of SHARED_COPIES) {
  test(`sharedRemotionCopies: ${fileName} がRemotion側と完全一致している`, () => {
    const desktopSource = readFileSync(
      join(import.meta.dirname, `../src/lib/${fileName}`),
      "utf-8",
    );
    const remotionSource = readFileSync(
      join(import.meta.dirname, `../../remotion/src/lib/${fileName}`),
      "utf-8",
    );
    assert.equal(
      desktopSource,
      remotionSource,
      `desktop/src/lib/${fileName} と remotion/src/lib/${fileName} の内容が食い違っている。片方を変更したらもう片方へコピーすること`,
    );
  });
}

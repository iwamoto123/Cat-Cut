import test from "node:test";
import assert from "node:assert/strict";
import {
  clampTelopYPercent,
  computeTelopBlockLayout,
  telopFitWidth,
  TELOP_SAFE_AREA_RATIO,
} from "../src/lib/telopLayout.ts";

/**
 * U1-3(縦位置・レイアウトの一致): telopLayout のデスクトップ側コピーのテスト。
 * ロジック本体のテストは remotion/tests/telopLayout.test.ts、Remotionとのファイル一致は
 * sharedRemotionCopies.test.ts が担保する。ここではdesktop側から使う代表経路のスモークのみ。
 */

test("computeTelopBlockLayout: 折返しと幅フィットの基本動作(desktop側スモーク)", () => {
  const layout = computeTelopBlockLayout({
    segmentTexts: ["白谷塾オンライン教室の夏期講習"],
    maxCharsPerLine: 16,
    baseFontSize: 72,
    letterSpacingEm: 0.03,
    fitWidth: 1280 * 0.92,
  });
  assert.equal(layout.lineTexts.join(""), "白谷塾オンライン教室の夏期講習");
  assert.ok(layout.fontSize > 0 && layout.fontSize <= 72);
});

test("clampTelopYPercent: telop_y+y_position_offsetをセーフエリア内へクランプする", () => {
  const base = { lineCount: 1, lineHeight: 1.35, fontSize: 72, videoHeight: 720 };
  // 中央付近はそのまま(%へ変換)
  assert.equal(clampTelopYPercent({ telopY: 0.5, yOffset: 0, ...base }), 50);
  // 下端ぎりぎり(telop_y=1.0)は下セーフエリア+ブロック半分の高さでクランプされる
  const clamped = clampTelopYPercent({ telopY: 1.0, yOffset: 0, ...base });
  const halfBlockRatio = (1 * 1.35 * 72) / 720 / 2;
  assert.equal(clamped, (1 - TELOP_SAFE_AREA_RATIO - halfBlockRatio) * 100);
  // 上方向オフセットも同様にクランプ
  assert.ok(clampTelopYPercent({ telopY: 0.0, yOffset: -0.5, ...base }) > 0);
});

test("telopFitWidth: 縦型は86%・横型は92%(desktop側スモーク。W24 Phase A-2)", () => {
  assert.equal(telopFitWidth(1920, 1080), 1920 * 0.92);
  assert.equal(telopFitWidth(1080, 1920), 1080 * 0.86);
});

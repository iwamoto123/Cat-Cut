import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInspectionCopyText,
  formatInspectionTimeMs,
  formatSceneWarningSuffix,
} from "../src/lib/inspectionCopyText.ts";
import type { Scene } from "../src/lib/scenes.ts";
import type { SuspicionItem } from "../src/lib/suspicionQueue.ts";

function makeScene(overrides: Partial<Scene> & Pick<Scene, "id">): Scene {
  return {
    sourceStartMs: 0,
    sourceEndMs: 1000,
    words: [],
    telopText: "",
    telopEdited: false,
    cutMarks: [],
    emotionTag: "normal",
    styleOverrideId: null,
    ...overrides,
  };
}

test("formatInspectionTimeMs: centisecond 精度で MM:SS.CC を返す", () => {
  assert.equal(formatInspectionTimeMs(200), "00:00.20");
  assert.equal(formatInspectionTimeMs(3000), "00:03.00");
  assert.equal(formatInspectionTimeMs(2680), "00:02.68");
});

test("formatSceneWarningSuffix: 境界はみ出し警告を仕様どおり整形する", () => {
  const items: SuspicionItem[] = [
    {
      id: "b1",
      type: "boundary_overrun",
      severity: "medium",
      label: "境界はみ出し（終了側）",
      text: "は",
      timestampMs: 5000,
      wordIds: ["w1"],
      detail: "95ms はみ出し",
    },
  ];
  assert.equal(formatSceneWarningSuffix(items), "[警告: 境界はみ出し（終了側） 95ms]");
});

test("buildInspectionCopyText: ヘッダーと全シーン行をプレーンテキストで出力する", () => {
  const scenes: Scene[] = [
    makeScene({
      id: "s1",
      sourceStartMs: 200,
      sourceEndMs: 2680,
      telopText: "ただし、一人一人手厚く指導するので",
    }),
    makeScene({
      id: "s2",
      sourceStartMs: 3000,
      sourceEndMs: 5290,
      telopText: "、枠には限りがあります",
    }),
  ];
  const suspicions = new Map<string, SuspicionItem[]>([
    [
      "s2",
      [
        {
          id: "b2",
          type: "boundary_overrun",
          severity: "medium",
          label: "境界はみ出し（終了側）",
          text: "は",
          timestampMs: 5000,
          wordIds: ["w2"],
          detail: "95ms はみ出し",
        },
      ],
    ],
  ]);
  const text = buildInspectionCopyText({
    runName: "20260703_test",
    scenes,
    suspicionsBySceneId: suspicions,
    generatedAt: new Date("2026-07-03T14:30:00"),
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "# Cat-Cut 検品テキスト (20260703_test / 2026-07-03 14:30)");
  assert.equal(lines[1], "1 [00:00.20-00:02.68] ただし、一人一人手厚く指導するので");
  assert.equal(
    lines[2],
    "2 [00:03.00-00:05.29] 、枠には限りがあります [警告: 境界はみ出し（終了側） 95ms]",
  );
});

test("buildInspectionCopyText: 手動改行入りテロップも1シーン=1行を保つ(改行は⏎で可視化)", () => {
  const scenes: Scene[] = [
    makeScene({
      id: "s1",
      sourceStartMs: 0,
      sourceEndMs: 2000,
      telopText: "山口県立大学を\n受験します",
    }),
  ];
  const text = buildInspectionCopyText({
    runName: "20260707_test",
    scenes,
    suspicionsBySceneId: new Map(),
    generatedAt: new Date("2026-07-07T00:00:00"),
  });
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "1 [00:00.00-00:02.00] 山口県立大学を⏎受験します");
});

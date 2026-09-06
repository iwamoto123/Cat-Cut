import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCutMark,
  attachSuspicionsToScenes,
  autoTelopTextFromWords,
  computeSceneKeptSubRanges,
  countTelopOccurrencesInOtherScenes,
  deriveKeepSegments,
  deriveTelopOverrides,
  findNextSelectionAfterSceneDelete,
  findSceneIndexAtMs,
  findTelopOccurrencesInOtherScenes,
  highestSeveritySuspicion,
  initializeScenes,
  isSceneFullyDeleted,
  mergeSceneWithNext,
  replaceTelopOccurrences,
  resetSceneIdCounterForTests,
  setChipDeleted,
  setChipsDeleted,
  setSceneTelopText,
  splitEditedTelopText,
  splitSceneAtMs,
  splitSceneAtWord,
  toggleChipDeleted,
  toggleChipsDeleted,
  type Scene,
  type SceneWord,
  type SourceSentence,
  type SourceWord,
  type TelopPageBoundary,
} from "../src/lib/scenes.ts";
import { buildSuspicionQueue } from "../src/lib/suspicionQueue.ts";

function words(...specs: Array<[string, string, number, number, string?]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs, sentenceId]) => ({ id, text, startMs, endMs, sentenceId }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

test("initializeScenes: 1 keep_segmentに文境界がなければ1シーンになる", () => {
  const testWords = words(["w1", "こ", 0, 100, "s1"], ["w2", "ん", 100, 200, "s1"], ["w3", "に", 200, 300, "s1"]);
  const sentences: SourceSentence[] = [{ id: "s1", wordIds: ["w1", "w2", "w3"], startMs: 0, endMs: 300 }];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 300 }] });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].sourceStartMs, 0);
  assert.equal(scenes[0].sourceEndMs, 300);
  assert.equal(scenes[0].words.length, 3);
  assert.equal(scenes[0].telopText, "こんに");
  assert.equal(scenes[0].telopEdited, false);
});

// =============================================================================
// 改善8-B-3(シーン初期化=テロップページ): telopPageBoundaries指定時は
// UI独自のヒューリスティック分割を使わず、BudouXページ境界に一致させて1シーン=1ページにする。
// =============================================================================

test("initializeScenes: telopPageBoundariesを指定すると、ヒューリスティックを使わずページ単位でシーンを分割する", () => {
  // ヒューリスティックなら「全角6文字未満は併合」で1シーンになってしまう短い文でも、
  // ページ境界が指定されていればそのまま2シーンに分かれることを確認する(改善8-B-3の主眼)。
  const testWords = words(
    ["w1", "こんにちは", 0, 500, "s1"],
    ["w2", "です", 500, 800, "s1"],
  );
  const sentences: SourceSentence[] = [{ id: "s1", wordIds: ["w1", "w2"], startMs: 0, endMs: 800 }];
  const pages: TelopPageBoundary[] = [
    { startMs: 0, endMs: 500 },
    { startMs: 500, endMs: 800 },
  ];
  const scenes = initializeScenes({
    words: testWords,
    sentences,
    keepSegments: [{ startMs: 0, endMs: 800 }],
    telopPageBoundaries: pages,
  });
  assert.equal(scenes.length, 2, "ヒューリスティックなら併合されるはずの短い行もページ境界通りに分かれる");
  assert.equal(scenes[0].telopText, "こんにちは");
  // W10-7(仕様変更): 正規化後2文字以下の極短シーンは初期telopTextが空欄になる("です"は2文字)。
  assert.equal(scenes[1].telopText, "");
  assert.equal(scenes[1].telopEdited, false, "空欄化は見た目のみでtelopEditedは立てない");
  assert.equal(scenes[0].sourceStartMs, 0);
  assert.equal(scenes[0].sourceEndMs, scenes[1].sourceStartMs, "ページ間の境界は前後ページの中点になる");
  assert.equal(scenes[1].sourceEndMs, 800);
});

test("initializeScenes: ページ境界がkeep_segmentの範囲をまたいでいても、シーンはkeep_segment境界内に収まる", () => {
  const testWords = words(["w1", "あいう", 100, 400, "s1"], ["w2", "えお", 400, 700, "s1"]);
  const sentences: SourceSentence[] = [{ id: "s1", wordIds: ["w1", "w2"], startMs: 100, endMs: 700 }];
  // ページ境界がkeep_segment([100,700])より外側にはみ出している(パイプライン側の丸め誤差を模す)。
  const pages: TelopPageBoundary[] = [{ startMs: 0, endMs: 1000 }];
  const scenes = initializeScenes({
    words: testWords,
    sentences,
    keepSegments: [{ startMs: 100, endMs: 700 }],
    telopPageBoundaries: pages,
  });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].sourceStartMs, 100, "先頭シーンはkeep_segment.startMsにクランプされる");
  assert.equal(scenes[0].sourceEndMs, 700, "末尾シーンはkeep_segment.endMsにクランプされる");
});

test("initializeScenes: あるkeep_segmentに対応するページが1件もない場合はその区間だけヒューリスティックへフォールバックする", () => {
  const testWords = words(
    ["w1", "こんにちは", 0, 500, "s1"],
    ["w2", "みなさん", 500, 900, "s1"],
    ["w3", "今日もよろしく", 2000, 2450, "s2"],
    ["w4", "お願いします", 2450, 2850, "s2"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1", "w2"], startMs: 0, endMs: 900 },
    { id: "s2", wordIds: ["w3", "w4"], startMs: 2000, endMs: 2850 },
  ];
  // 2番目のkeep_segment([2000,2850])に対応するページが無い(取りこぼしを模す)。
  const pages: TelopPageBoundary[] = [{ startMs: 0, endMs: 900 }];
  const scenes = initializeScenes({
    words: testWords,
    sentences,
    keepSegments: [
      { startMs: 0, endMs: 900 },
      { startMs: 2000, endMs: 2850 },
    ],
    telopPageBoundaries: pages,
  });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].telopText, "こんにちはみなさん", "ページがある区間はページ通り1シーン");
  assert.equal(scenes[1].telopText, "今日もよろしくお願いします", "ページが無い区間はヒューリスティックで文境界分割");
});

test("initializeScenes: telopPageBoundariesが空配列なら従来のヒューリスティック分割にフォールバックする", () => {
  const testWords = words(["w1", "こ", 0, 100, "s1"], ["w2", "ん", 100, 200, "s1"], ["w3", "に", 200, 300, "s1"]);
  const sentences: SourceSentence[] = [{ id: "s1", wordIds: ["w1", "w2", "w3"], startMs: 0, endMs: 300 }];
  const scenes = initializeScenes({
    words: testWords,
    sentences,
    keepSegments: [{ startMs: 0, endMs: 300 }],
    telopPageBoundaries: [],
  });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].telopText, "こんに");
});

// 改善2(シーン行の分割位置を自然に)により、全角6文字未満の行は前後に併合されるようになった。
// そのため文境界での分割を検証するテストは、各文が最短長(6文字)以上になるテキストを用いる。
test("initializeScenes: keep_segment内の文境界でシーンを分割する", () => {
  const testWords = words(
    ["w1", "こんにちは", 0, 500, "s1"],
    ["w2", "みなさん", 500, 900, "s1"],
    ["w3", "今日もよろしく", 950, 1400, "s2"],
    ["w4", "お願いします", 1400, 1800, "s2"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1", "w2"], startMs: 0, endMs: 900 },
    { id: "s2", wordIds: ["w3", "w4"], startMs: 950, endMs: 1800 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 1800 }] });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].sourceStartMs, 0);
  assert.equal(scenes[0].sourceEndMs, scenes[1].sourceStartMs, "分割境界で隙間なく接している");
  assert.equal(scenes[1].sourceEndMs, 1800);
  assert.equal(scenes[0].telopText, "こんにちはみなさん");
  assert.equal(scenes[1].telopText, "今日もよろしくお願いします");

  // 編集をしていない場合、deriveKeepSegmentsは元のkeep_segmentsに一致する(隣接シーンが再結合される)。
  const rebuilt = deriveKeepSegments(scenes);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].startMs, 0);
  assert.equal(rebuilt[0].endMs, 1800);
});

test("initializeScenes: 句読点(。)の直後を最優先の分割点にする(改善2 規則1、sentencesメタデータなし)", () => {
  // 実際のSTT出力同様、句読点は独立した単語として現れる。sentencesを渡さなくても句読点だけで分割できる。
  const testWords = words(
    ["w1", "こんにちは", 0, 400],
    ["w2", "。", 400, 400],
    ["w3", "また来てくださいね", 450, 1200],
    ["w4", "。", 1200, 1200],
  );
  // keep_segmentの終端は最後の単語(ゼロ幅の句読点)より後ろに置く(word.startMs<segment.endMsの
  // フィルタ条件を満たすため。実データでは句読点の後にpaddingがあるため通常は問題にならない)。
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 1210 }] });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].telopText, "こんにちは");
  assert.equal(scenes[1].telopText, "また来てくださいね");
});

test("initializeScenes: 単語間ギャップ500ms超のポーズを分割点にする(改善2 規則1、句読点なし)", () => {
  const testWords = words(
    ["w1", "えっとですね", 0, 800],
    ["w2", "続きを話しますよ", 1400, 2200], // 前の単語末尾(800)からgap=600ms>500ms
  );
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 2200 }] });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].telopText, "えっとですね");
  assert.equal(scenes[1].telopText, "続きを話しますよ");
});

test("initializeScenes: 500ms以下のギャップでは分割しない(改善2 規則1の閾値確認)", () => {
  const testWords = words(
    ["w1", "えっとですね", 0, 800],
    ["w2", "続きを話しますよ", 1250, 2200], // gap=450ms<=500ms
  );
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 2200 }] });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].telopText, "えっとですね続きを話しますよ");
});

test("initializeScenes: 全角24文字を超える行は助詞の直後で再分割する(改善2 規則2)", () => {
  // runs/20260428_test の実データに現れる文と同一(26文字)。「あっても」の「も」の直後で
  // 「こうやって間があっても」(11文字)/「カットできるかテストしてます。」(15文字)に分かれる想定。
  const chars = [..."こうやって間があってもカットできるかテストしてます。"];
  let cursor = 0;
  const testWords = words(
    ...chars.map((ch, index) => {
      const startMs = cursor;
      cursor += 100;
      return [`w${index}`, ch, startMs, cursor] as [string, string, number, number];
    }),
  );
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: cursor }] });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].telopText, "こうやって間があっても");
  assert.equal(scenes[1].telopText, "カットできるかテストしてます");
  // どちらの行も最短長(6文字)以上になっている。
  assert.ok(scenes.every((scene) => [...scene.telopText].length >= 6));
  // 分割しても隙間なく連続し、書き出し時は1つのkeep_segmentに戻る。
  assert.deepEqual(deriveKeepSegments(scenes), [{ startMs: 0, endMs: cursor }]);
});

test("initializeScenes: 改行規則v2 - 第2分割点は読点『、』直後を助詞直後より優先する", () => {
  // 「状況は」の「は」(8文字目)は助詞境界の条件を満たすが、その後に読点境界(「ですね、」の直後、
  // 12文字目)が見つかるため、読点が優先されて後者で分割される想定(改善7-5)。
  const chars = [..."これまでの状況はですね、担当者に確認を進めております"];
  let cursor = 0;
  const testWords = words(
    ...chars.map((ch, index) => {
      const startMs = cursor;
      cursor += 100;
      return [`w${index}`, ch, startMs, cursor] as [string, string, number, number];
    }),
  );
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: cursor }] });
  assert.equal(scenes.length, 2);
  // 改善14-C: シーン末尾の読点は除去される
  assert.equal(scenes[0].telopText, "これまでの状況はですね");
  assert.equal(scenes[1].telopText, "担当者に確認を進めております");
});

test("initializeScenes: 改行規則v2 - 「一、」等の列挙トークン直後は分割点にせず次内容と同行に保つ", () => {
  // 「一、」(6文字目)は列挙トークンとして読点境界から除外されるため、そこでは分割されず、
  // 後方の助詞「ので」の直後(15文字目)で分割される想定(改善7-5)。
  const chars = [..."それでは一、資料を配りますのでご確認くださいお願いします"];
  let cursor = 0;
  const testWords = words(
    ...chars.map((ch, index) => {
      const startMs = cursor;
      cursor += 100;
      return [`w${index}`, ch, startMs, cursor] as [string, string, number, number];
    }),
  );
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: cursor }] });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].telopText, "それでは一、資料を配りますので");
  assert.equal(scenes[1].telopText, "ご確認くださいお願いします");
  // 「一、」の直後で分割されていない(=列挙トークンが独立行の末尾になっていない)ことを確認する。
  assert.ok(!scenes.some((scene) => scene.telopText.endsWith("一、")));
});

test("initializeScenes: 改行規則v2 - 「お」「ご」1文字接頭語で終わる読点境界は分割点にしない", () => {
  // 「しましたお、」の「お、」(16文字目)は禁則により読点境界から除外されるため、
  // 後方の助詞「に」の直後(24文字目)で分割される想定(改善7-5)。
  const chars = [..."これまでの状況を整理しましたお、続けて次の議題に移りましょう"];
  let cursor = 0;
  const testWords = words(
    ...chars.map((ch, index) => {
      const startMs = cursor;
      cursor += 100;
      return [`w${index}`, ch, startMs, cursor] as [string, string, number, number];
    }),
  );
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: cursor }] });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].telopText, "これまでの状況を整理しましたお、続けて次の議題に");
  assert.equal(scenes[1].telopText, "移りましょう");
  // 「お、」の直後で分割されていない(=禁則が効いている)ことを確認する。
  assert.ok(!scenes.some((scene) => scene.telopText.endsWith("お、")));
});

test("initializeScenes: 全角6文字未満の行は前の行に併合する(改善2 規則3)", () => {
  // 句読点で区切ると2文目が「ね。」(2文字)だけになってしまうケース -> 前の行に併合されるはず。
  const testWords = words(
    ["w1", "これはテストの文章です", 0, 1000],
    ["w2", "。", 1000, 1000],
    ["w3", "ね", 1050, 1150],
    ["w4", "。", 1150, 1150],
  );
  // keep_segmentの終端は最後の単語(ゼロ幅の句読点)より後ろに置く(理由は前のテストと同じ)。
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 1160 }] });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].telopText, "これはテストの文章ですね");
});

test("initializeScenes: 複数keep_segmentsからそれぞれシーンが作られる", () => {
  const testWords = words(["w1", "あ", 0, 100, "s1"], ["w2", "い", 500, 600, "s2"]);
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 100 },
    { id: "s2", wordIds: ["w2"], startMs: 500, endMs: 600 },
  ];
  const scenes = initializeScenes({
    words: testWords,
    sentences,
    keepSegments: [
      { startMs: 0, endMs: 100 },
      { startMs: 500, endMs: 600 },
    ],
  });
  assert.equal(scenes.length, 2);
  assert.deepEqual(deriveKeepSegments(scenes), [
    { startMs: 0, endMs: 100 },
    { startMs: 500, endMs: 600 },
  ]);
});

test("setChipDeleted/toggleChipDeleted: 未編集telopは自動再生成され、keep_segmentsにギャップができる", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200], ["w3", "う", 200, 300]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 300 }] });
  const sceneId = scenes[0].id;

  const afterDelete = setChipDeleted(scenes, sceneId, "w2", true);
  assert.equal(afterDelete[0].telopText, "あう");
  assert.equal(afterDelete[0].words.find((w) => w.id === "w2")?.deleted, true);

  const segments = deriveKeepSegments(afterDelete);
  assert.deepEqual(segments, [
    { startMs: 0, endMs: 100 },
    { startMs: 200, endMs: 300 },
  ]);

  const restored = toggleChipDeleted(afterDelete, sceneId, "w2");
  assert.equal(restored[0].telopText, "あいう");
  assert.deepEqual(deriveKeepSegments(restored), [{ startMs: 0, endMs: 300 }]);
});

test("setChipsDeleted/toggleChipsDeleted: 改善1(単語グループチップ)の複数word一括削除は1回の不変更新で完結する", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200], ["w3", "う", 200, 300], ["w4", "え", 300, 400]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 400 }] });
  const sceneId = scenes[0].id;

  // グループ「いう」(w2,w3)を一括削除する。
  const afterDelete = setChipsDeleted(scenes, sceneId, ["w2", "w3"], true);
  assert.equal(afterDelete[0].telopText, "あえ");
  assert.equal(afterDelete[0].words.find((w) => w.id === "w2")?.deleted, true);
  assert.equal(afterDelete[0].words.find((w) => w.id === "w3")?.deleted, true);
  assert.equal(afterDelete[0].words.find((w) => w.id === "w1")?.deleted, false);
  assert.deepEqual(deriveKeepSegments(afterDelete), [
    { startMs: 0, endMs: 100 },
    { startMs: 300, endMs: 400 },
  ]);

  // toggleChipsDeletedは「全員deleted」の場合のみ復元(false)へ倒す。
  const restored = toggleChipsDeleted(afterDelete, sceneId, ["w2", "w3"]);
  assert.equal(restored[0].telopText, "あいうえ");
  assert.deepEqual(deriveKeepSegments(restored), [{ startMs: 0, endMs: 400 }]);

  // 1回のsetChipsDeleted呼び出しで完結する(=呼び出し側のUndoスタックでは1操作分になる)ことを、
  // 「w2だけ削除した状態」を経由せずに直接afterDeleteへ到達している(scenesから連続適用していない)
  // ことで確認する。
  const afterDeleteAgain = setChipsDeleted(scenes, sceneId, ["w2", "w3"], true);
  assert.deepEqual(afterDeleteAgain, afterDelete);
});

test("toggleChipsDeleted: 一部だけdeletedな状態から呼ぶと(未削除が混在)全員削除の方向へ倒す", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200], ["w3", "う", 200, 300]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 300 }] });
  const sceneId = scenes[0].id;
  const partiallyDeleted = setChipDeleted(scenes, sceneId, "w2", true);
  const toggled = toggleChipsDeleted(partiallyDeleted, sceneId, ["w2", "w3"]);
  assert.equal(toggled[0].words.find((w) => w.id === "w2")?.deleted, true);
  assert.equal(toggled[0].words.find((w) => w.id === "w3")?.deleted, true);
});

test("setSceneTelopText: 自動テキストと異なる場合のみtelopEditedがtrueになる", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 200 }] });
  const sceneId = scenes[0].id;

  const edited = setSceneTelopText(scenes, sceneId, "カスタムテロップ");
  assert.equal(edited[0].telopEdited, true);
  assert.equal(edited[0].telopText, "カスタムテロップ");

  const revertedToAuto = setSceneTelopText(edited, sceneId, "あい");
  assert.equal(revertedToAuto[0].telopEdited, false);
});

test("deriveTelopOverrides: 編集していないシーンはnull(自動テロップのまま)", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 500, 600]);
  const scenes = initializeScenes({
    words: testWords,
    keepSegments: [
      { startMs: 0, endMs: 100 },
      { startMs: 500, endMs: 600 },
    ],
  });
  assert.deepEqual(deriveTelopOverrides(scenes), [null, null]);
});

test("deriveTelopOverrides: 編集済みシーンのテキストが対応するkeep_segmentに割り当てられる", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 500, 600]);
  const scenes = initializeScenes({
    words: testWords,
    keepSegments: [
      { startMs: 0, endMs: 100 },
      { startMs: 500, endMs: 600 },
    ],
  });
  const edited = setSceneTelopText(scenes, scenes[1].id, "手動テロップ");
  assert.deepEqual(deriveTelopOverrides(edited), [null, "手動テロップ"]);
});

test("deriveTelopOverrides: チップ削除で1シーンが2つのkeep_segmentに分裂した場合は最初のグループにだけ全文を割り当てる", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200], ["w3", "う", 200, 300]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 300 }] });
  const edited = setSceneTelopText(scenes, scenes[0].id, "手動全文");
  const withGap = setChipDeleted(edited, scenes[0].id, "w2", true);
  const segments = deriveKeepSegments(withGap);
  assert.equal(segments.length, 2);
  assert.deepEqual(deriveTelopOverrides(withGap), ["手動全文", null]);
});

test("deriveTelopOverrides: 隣接する2シーンが1つのkeep_segmentに合併した場合はシーン順に連結する", () => {
  // 改善2(全角6文字未満の行を作らない)に配慮し、各文が6文字以上になるテキストを使う。
  const testWords = words(
    ["w1", "おはようございます", 0, 500, "s1"],
    ["w2", "今日もよろしくお願いします", 550, 1200, "s2"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 500 },
    { id: "s2", wordIds: ["w2"], startMs: 550, endMs: 1200 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 1200 }] });
  assert.equal(scenes.length, 2);
  const edited = setSceneTelopText(scenes, scenes[1].id, "後半だけ手動");
  assert.deepEqual(deriveKeepSegments(edited), [{ startMs: 0, endMs: 1200 }]);
  assert.deepEqual(deriveTelopOverrides(edited), ["おはようございます後半だけ手動"]);
});

test("splitSceneAtWord: チップ境界で前後シーンに分配される", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200], ["w3", "う", 200, 300]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 300 }] });
  const split = splitSceneAtWord(scenes, scenes[0].id, "w2");
  assert.equal(split.length, 2);
  assert.deepEqual(split[0].words.map((w) => w.id), ["w1"]);
  assert.deepEqual(split[1].words.map((w) => w.id), ["w2", "w3"]);
  assert.equal(split[0].sourceEndMs, split[1].sourceStartMs);
  assert.equal(split[0].sourceStartMs, 0);
  assert.equal(split[1].sourceEndMs, 300);
  // 分割しても書き出しは1本のkeep_segmentのまま(隙間なし)。
  assert.deepEqual(deriveKeepSegments(split), [{ startMs: 0, endMs: 300 }]);
});

test("splitSceneAtWord: 編集済みtelopTextは前後半へ分配され、両側telopEditedが維持される(W10-4)", () => {
  // W10-4(仕様変更): 旧挙動「前半に全文コピー+後半は自動再生成」は上下同一表示の原因のため廃止。
  // words("あ","い","う")のテキストは編集文と一致しないため比率フォールバック(1:2)で分配される。
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200], ["w3", "う", 200, 300]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 300 }] });
  const edited = setSceneTelopText(scenes, scenes[0].id, "編集済み全文");
  const split = splitSceneAtWord(edited, edited[0].id, "w2");
  assert.equal(split[0].telopEdited, true);
  assert.equal(split[1].telopEdited, true, "後半も編集済み扱い(自動再生成で編集文言を失わない)");
  assert.equal(split[0].telopText + split[1].telopText, "編集済み全文", "全文が過不足なく前後半へ分配される");
  assert.notEqual(split[0].telopText, "編集済み全文", "前半への全文複製はしない");
  assert.notEqual(split[1].telopText, "編集済み全文", "後半への全文複製はしない");
});

test("mergeSceneWithNext: 2つのシーンを1つに結合する", () => {
  // 改善2(全角6文字未満の行を作らない)に配慮し、各文が6文字以上になるテキストを使う。
  const testWords = words(
    ["w1", "おはようございます", 0, 500, "s1"],
    ["w2", "今日もよろしくお願いします", 550, 1200, "s2"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 500 },
    { id: "s2", wordIds: ["w2"], startMs: 550, endMs: 1200 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 1200 }] });
  assert.equal(scenes.length, 2);
  const merged = mergeSceneWithNext(scenes, scenes[0].id);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sourceStartMs, 0);
  assert.equal(merged[0].sourceEndMs, 1200);
  assert.deepEqual(merged[0].words.map((w) => w.id), ["w1", "w2"]);
  assert.equal(merged[0].telopText, "おはようございます今日もよろしくお願いします");
});

test("W13-4 mergeSceneWithNext: 未編集でもAI整形済み表示テキスト同士の連結になる(words由来への巻き戻り禁止)", () => {
  const testWords = words(
    ["w1", "おはようございます", 0, 500, "s1"],
    ["w2", "今日もよろしくお願いします", 550, 1200, "s2"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 500 },
    { id: "s2", wordIds: ["w2"], startMs: 550, endMs: 1200 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 1200 }] });
  // AI整形済みテキスト(composition.jsonのpageText相当)はwords連結と異なるがtelopEdited=false
  const refined = scenes.map((scene, index) => ({
    ...scene,
    telopText: index === 0 ? "おはよう\nございます!" : "今日もよろしく\nお願いします!",
  }));
  const merged = mergeSceneWithNext(refined, refined[0].id);
  assert.equal(merged.length, 1);
  // 表示テキスト同士の連結(境界の改行以外は保持)。words由来の再生成はしない
  assert.equal(merged[0].telopText, "おはよう\nございます!今日もよろしく\nお願いします!");
  // 自動生成と異なるため編集済み扱い=以降のwords再生成から保護される
  assert.equal(merged[0].telopEdited, true);
});

test("W13-4 mergeSceneWithNext: 編集済みシーンとの結合も表示テキスト連結(編集フラグ維持)", () => {
  const testWords = words(
    ["w1", "おはようございます", 0, 500, "s1"],
    ["w2", "今日もよろしくお願いします", 550, 1200, "s2"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 500 },
    { id: "s2", wordIds: ["w2"], startMs: 550, endMs: 1200 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 1200 }] });
  const edited = setSceneTelopText(scenes, scenes[0].id, "おはよう！");
  assert.equal(edited[0].telopEdited, true);
  const merged = mergeSceneWithNext(edited, edited[0].id);
  assert.equal(merged[0].telopText, "おはよう！今日もよろしくお願いします");
  assert.equal(merged[0].telopEdited, true);
});

test("W13-4 mergeSceneWithNext: 空テロップ(相槌等)との結合は相手側のテキストだけ残る", () => {
  const testWords = words(
    ["w1", "おはようございます", 0, 500, "s1"],
    ["w2", "今日もよろしくお願いします", 550, 1200, "s2"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 500 },
    { id: "s2", wordIds: ["w2"], startMs: 550, endMs: 1200 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 1200 }] });
  const blanked = scenes.map((scene, index) => (index === 0 ? { ...scene, telopText: "" } : scene));
  const merged = mergeSceneWithNext(blanked, blanked[0].id);
  assert.equal(merged[0].telopText, "今日もよろしくお願いします");
});

test("W28 mergeSceneWithNext: 間の丸ごと削除済みシーンをまたいで次の生きたシーンと結合する", () => {
  const testWords = words(
    ["w1", "おはようございます", 0, 500, "s1"],
    ["w2", "えっと言い直します", 550, 1200, "s2"],
    ["w3", "今日もよろしくお願いします", 1250, 2000, "s3"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 500 },
    { id: "s2", wordIds: ["w2"], startMs: 550, endMs: 1200 },
    { id: "s3", wordIds: ["w3"], startMs: 1250, endMs: 2000 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 2000 }] });
  assert.equal(scenes.length, 3);
  // 言い直しで中央シーンを丸ごと削除した状態を作る
  const deletedMiddle = scenes.map((scene, index) =>
    index === 1 ? { ...scene, words: scene.words.map((word) => ({ ...word, deleted: true })) } : scene,
  );
  assert.equal(isSceneFullyDeleted(deletedMiddle[1]), true);
  const merged = mergeSceneWithNext(deletedMiddle, deletedMiddle[0].id);
  assert.equal(merged.length, 1, "削除済みシーンをまたいで1つに結合される");
  assert.equal(merged[0].sourceStartMs, 0);
  assert.equal(merged[0].sourceEndMs, 2000);
  // 削除済みワードは削除状態のまま取り込む(チップから復元可能)
  assert.deepEqual(merged[0].words.map((word) => word.id), ["w1", "w2", "w3"]);
  assert.deepEqual(merged[0].words.map((word) => word.deleted), [false, true, false]);
  // テロップ本文に削除済みシーンのテキストは混ぜない
  assert.equal(merged[0].telopText, "おはようございます今日もよろしくお願いします");
});

test("W29 mergeSceneWithNext: 末尾の残存シーンから結合しても間の削除済みをまたいで1つになる", () => {
  const testWords = words(
    ["w1", "おはようございます", 0, 500, "s1"],
    ["w2", "えっと言い直します", 550, 1200, "s2"],
    ["w3", "今日もよろしくお願いします", 1250, 2000, "s3"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 500 },
    { id: "s2", wordIds: ["w2"], startMs: 550, endMs: 1200 },
    { id: "s3", wordIds: ["w3"], startMs: 1250, endMs: 2000 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 2000 }] });
  const deletedMiddle = scenes.map((scene, index) =>
    index === 1 ? { ...scene, words: scene.words.map((word) => ({ ...word, deleted: true })) } : scene,
  );
  const merged = mergeSceneWithNext(deletedMiddle, deletedMiddle[2].id);
  assert.equal(merged.length, 1, "後ろの残存行から結合しても1つになる");
  assert.equal(merged[0].telopText, "おはようございます今日もよろしくお願いします");
});

test("W29 mergeSceneWithNext: 削除済みの中間行を起点にしても前後の残存行が結合される", () => {
  const testWords = words(
    ["w1", "おはようございます", 0, 500, "s1"],
    ["w2", "えっと言い直します", 550, 1200, "s2"],
    ["w3", "今日もよろしくお願いします", 1250, 2000, "s3"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 500 },
    { id: "s2", wordIds: ["w2"], startMs: 550, endMs: 1200 },
    { id: "s3", wordIds: ["w3"], startMs: 1250, endMs: 2000 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 2000 }] });
  const deletedMiddle = scenes.map((scene, index) =>
    index === 1 ? { ...scene, words: scene.words.map((word) => ({ ...word, deleted: true })) } : scene,
  );
  const merged = mergeSceneWithNext(deletedMiddle, deletedMiddle[1].id);
  assert.equal(merged.length, 1, "削除済み中間行を起点にしても前後が結合される");
  assert.equal(merged[0].telopText, "おはようございます今日もよろしくお願いします");
});

test("W28 mergeSceneWithNext: 結合後の見た目は上のシーンを全面優先する(下のエフェクト・スタイルを引き継がない)", () => {
  const testWords = words(
    ["w1", "おはようございます", 0, 500, "s1"],
    ["w2", "今日もよろしくお願いします", 550, 1200, "s2"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1"], startMs: 0, endMs: 500 },
    { id: "s2", wordIds: ["w2"], startMs: 550, endMs: 1200 },
  ];
  const scenes = initializeScenes({ words: testWords, sentences, keepSegments: [{ startMs: 0, endMs: 1200 }] });
  const styled = scenes.map((scene, index) =>
    index === 1
      ? {
          ...scene,
          directedStyleId: "emotion_red",
          directedType: "emphasis",
          directedAnimationIn: "slam",
          styleOverrideId: "pop_energetic",
          videoEffectOverride: "zoom" as const,
        }
      : scene,
  );
  const merged = mergeSceneWithNext(styled, styled[0].id);
  assert.equal(merged[0].directedStyleId, undefined, "下のdirectedスタイルを引き継がない");
  assert.equal(merged[0].directedType, undefined, "下のtypeを引き継がない");
  assert.equal(merged[0].directedAnimationIn, undefined, "下のアニメ上書きを引き継がない");
  assert.equal(merged[0].styleOverrideId, null, "下のスタイル上書きを引き継がない");
  assert.equal(merged[0].videoEffectOverride, undefined, "下の映像演出を引き継がない");
});

test("W28 splitSceneAtMs: シーン先頭の無音(ワード無し区間)でも分割でき、空側に無音チップが生成される", () => {
  const testWords = words(["w1", "こんにちは", 2000, 2500]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 2500 }] });
  assert.equal(scenes[0].sourceStartMs, 0);
  const split = splitSceneAtMs(scenes, scenes[0].id, 1000);
  assert.equal(split.length, 2, "旧実装(両側に単語必須)では分割できなかったケース");
  assert.equal(split[0].words.length, 1);
  assert.equal(split[0].words[0].silence, true, "空側はその区間を表す無音チップになる");
  assert.equal(split[0].words[0].startMs, 0);
  assert.equal(split[0].words[0].endMs, 1000);
  assert.equal(split[0].telopText, "");
  assert.deepEqual(split[1].words.map((word) => word.id), ["w1"]);
});

test("W28 splitSceneAtMs: 無音チップ内部での分割はチップを2つに割って両側へ入れる", () => {
  // w1とw2の間に1000msのギャップ → 無音チップ sil_w1(500〜1500ms)が挿入される
  const testWords = words(["w1", "こんにちは", 0, 500], ["w2", "です", 1500, 2000]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 2000 }] });
  assert.equal(scenes[0].words.some((word) => word.silence), true);
  const split = splitSceneAtMs(scenes, scenes[0].id, 1000);
  assert.equal(split.length, 2);
  assert.deepEqual(split[0].words.map((word) => word.id), ["w1", "sil_w1L"]);
  assert.equal(split[0].words[1].endMs, 1000);
  assert.deepEqual(split[1].words.map((word) => word.id), ["sil_w1R", "w2"]);
  assert.equal(split[1].words[0].startMs, 1000);
});

test("W28 splitSceneAtMs: 分割点が音声ワードの内部に落ちて片側が空になる場合は従来どおり分割しない", () => {
  const testWords = words(["w1", "こんにちは", 0, 1000]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 1000 }] });
  // 300msはw1(中点500ms)の内部 → w1は後半側扱いで前半が空になるが、無音ではないので分割しない
  const split = splitSceneAtMs(scenes, scenes[0].id, 300);
  assert.equal(split.length, 1);
});

test("splitSceneAtMs: 切り込み位置ちょうどでシーンが分割され、境界にまたがるチップは中点が属する側に丸ごと入る", () => {
  // w2は120〜260msで、中点190msは分割点200msより前 -> 前半シーンに丸ごと入る想定。
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 120, 260], ["w3", "う", 280, 400]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 400 }] });
  const split = splitSceneAtMs(scenes, scenes[0].id, 200);
  assert.equal(split.length, 2);
  assert.deepEqual(split[0].words.map((w) => w.id), ["w1", "w2"]);
  assert.deepEqual(split[1].words.map((w) => w.id), ["w3"]);
  assert.equal(split[0].sourceStartMs, 0);
  assert.equal(split[0].sourceEndMs, 200);
  assert.equal(split[1].sourceStartMs, 200);
  assert.equal(split[1].sourceEndMs, 400);
});

test("splitSceneAtMs: 中点が分割点より後ろのチップは後半シーンに入る", () => {
  // w2は120〜260msで、中点190msは分割点150msより後ろ -> 後半シーンに丸ごと入る想定。
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 120, 260], ["w3", "う", 280, 400]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 400 }] });
  const split = splitSceneAtMs(scenes, scenes[0].id, 150);
  assert.deepEqual(split[0].words.map((w) => w.id), ["w1"]);
  assert.deepEqual(split[1].words.map((w) => w.id), ["w2", "w3"]);
});

test("splitSceneAtMs: シーン範囲外・境界ちょうどのmsでは分割しない", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 200 }] });
  assert.equal(splitSceneAtMs(scenes, scenes[0].id, 0), scenes);
  assert.equal(splitSceneAtMs(scenes, scenes[0].id, 200), scenes);
  assert.equal(splitSceneAtMs(scenes, scenes[0].id, 9999), scenes);
});

test("splitSceneAtMs: 分割してもcutMarksは分割点を境に前後シーンに引き継がれる", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200], ["w3", "う", 200, 300]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 300 }] });
  const withMarks = addCutMark(addCutMark(scenes, scenes[0].id, 50), scenes[0].id, 250);
  const split = splitSceneAtMs(withMarks, scenes[0].id, 150);
  assert.deepEqual(split[0].cutMarks, [50]);
  assert.deepEqual(split[1].cutMarks, [250]);
});

test("addCutMark: 昇順・重複なしで切り込み位置を追加し、範囲外は無視する", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 100, 200]);
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 200 }] });
  const withMarks = addCutMark(addCutMark(scenes, scenes[0].id, 150), scenes[0].id, 50);
  assert.deepEqual(withMarks[0].cutMarks, [50, 150]);
  const unchanged = addCutMark(withMarks, scenes[0].id, 150);
  assert.deepEqual(unchanged[0].cutMarks, [50, 150]);
  const ignoredOutOfRange = addCutMark(withMarks, scenes[0].id, 9999);
  assert.deepEqual(ignoredOutOfRange[0].cutMarks, [50, 150]);
});

test("computeSceneKeptSubRanges: 削除区間を除いた残存区間を計算する", () => {
  const scene: Scene = {
    id: "s",
    sourceStartMs: 0,
    sourceEndMs: 300,
    words: [
      { id: "w1", text: "あ", startMs: 0, endMs: 100, deleted: false },
      { id: "w2", text: "い", startMs: 100, endMs: 200, deleted: true },
      { id: "w3", text: "う", startMs: 200, endMs: 300, deleted: false },
    ],
    telopText: "あう",
    telopEdited: false,
    cutMarks: [],
  };
  assert.deepEqual(computeSceneKeptSubRanges(scene), [
    { startMs: 0, endMs: 100 },
    { startMs: 200, endMs: 300 },
  ]);
});

test("computeSceneKeptSubRanges: 全単語削除なら単語間ポーズ・シーン端の余白ごと空になる(無音断片を残さない)", () => {
  // 単語間にポーズ(100-150, 250-280)、シーン端に余白(0-50, 380-400)があっても、
  // 全単語deletedならシーン全体が削除扱いになること(V8追補: リップル削除の無音断片対策)。
  const scene: Scene = {
    id: "s",
    sourceStartMs: 0,
    sourceEndMs: 400,
    words: [
      { id: "w1", text: "あ", startMs: 50, endMs: 100, deleted: true },
      { id: "w2", text: "い", startMs: 150, endMs: 250, deleted: true },
      { id: "w3", text: "う", startMs: 280, endMs: 380, deleted: true },
    ],
    telopText: "",
    telopEdited: false,
    cutMarks: [],
  };
  assert.deepEqual(computeSceneKeptSubRanges(scene), []);
});

test("computeSceneKeptSubRanges: 先頭/末尾単語を含む削除ランはシーン境界まで拡張され、連続ラン内のポーズも消える", () => {
  const scene: Scene = {
    id: "s",
    sourceStartMs: 0,
    sourceEndMs: 500,
    words: [
      { id: "w1", text: "あ", startMs: 30, endMs: 100, deleted: true }, // 先頭ラン→[0,100]
      { id: "w2", text: "い", startMs: 150, endMs: 200, deleted: false },
      { id: "w3", text: "う", startMs: 240, endMs: 300, deleted: true }, // 連続ラン(w3+w4)→ポーズ300-330も削除
      { id: "w4", text: "え", startMs: 330, endMs: 400, deleted: true },
      { id: "w5", text: "お", startMs: 440, endMs: 470, deleted: false }, // 末尾は残存→[400,500]
    ],
    telopText: "いお",
    telopEdited: false,
    cutMarks: [],
  };
  assert.deepEqual(computeSceneKeptSubRanges(scene), [
    { startMs: 100, endMs: 240 },
    { startMs: 400, endMs: 500 },
  ]);
});

test("deriveKeepSegments: シーン丸ごと削除で無音断片が残らず、前後シーンだけになる", () => {
  // 3シーンが隙間なく並ぶ中で中央シーンの全単語を削除→中央のシーン区間が丸ごと消えること。
  const testWords = words(
    ["w1", "あ", 0, 90],
    ["w2", "い", 110, 200],
    ["w3", "う", 220, 300], // 中央シーン(200-400)の単語(ポーズ・余白入り)
    ["w4", "え", 320, 380],
    ["w5", "お", 410, 500],
    ["w6", "か", 520, 600],
  );
  const scenes = initializeScenes({
    words: testWords,
    keepSegments: [{ startMs: 0, endMs: 600 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 200 },
      { startMs: 200, endMs: 400 },
      { startMs: 400, endMs: 600 },
    ],
  });
  assert.equal(scenes.length, 3);
  const middle = scenes[1];
  const deleted = setChipsDeleted(
    scenes,
    middle.id,
    middle.words.map((word) => word.id),
    true,
  );
  assert.deepEqual(deriveKeepSegments(deleted), [
    { startMs: 0, endMs: middle.sourceStartMs },
    { startMs: middle.sourceEndMs, endMs: 600 },
  ]);
});

test("findSceneIndexAtMs: 時刻からシーンindexを引ける", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 500, 600]);
  const scenes = initializeScenes({
    words: testWords,
    keepSegments: [
      { startMs: 0, endMs: 100 },
      { startMs: 500, endMs: 600 },
    ],
  });
  assert.equal(findSceneIndexAtMs(scenes, 50), 0);
  assert.equal(findSceneIndexAtMs(scenes, 550), 1);
  assert.equal(findSceneIndexAtMs(scenes, 300), -1);
});

test("attachSuspicionsToScenes / highestSeveritySuspicion: 疑義をシーンに紐づけて最重要度を取れる", () => {
  const testWords = [
    { id: "w1", text: "あ", startMs: 0, endMs: 100, confidence: 0.2 },
    { id: "w2", text: "い", startMs: 100, endMs: 200, confidence: 1 },
  ];
  const keepSegments = [{ startMs: 0, endMs: 200 }];
  const suspicions = buildSuspicionQueue({ words: testWords, keepSegments });
  assert.ok(suspicions.length > 0);

  const scenes = initializeScenes({
    words: testWords.map(({ id, text, startMs, endMs }) => ({ id, text, startMs, endMs })),
    keepSegments,
  });
  const map = attachSuspicionsToScenes(scenes, suspicions);
  const sceneId = scenes[0].id;
  assert.ok(map.get(sceneId)?.length);
  const top = highestSeveritySuspicion(map.get(sceneId));
  assert.equal(top?.type, "low_confidence");
});

// --- 改善5-7(一括置換ポップアップ): 他シーンへの一括置換用の純関数 ---

test("countTelopOccurrencesInOtherScenes: 編集中のシーン自身は数えず、他シーンの出現数を合計する", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 500, 600], ["w3", "う", 1000, 1100]);
  const scenes = initializeScenes({
    words: testWords,
    keepSegments: [
      { startMs: 0, endMs: 100 },
      { startMs: 500, endMs: 600 },
      { startMs: 1000, endMs: 1100 },
    ],
  });
  const edited = setSceneTelopText(scenes, scenes[0].id, "谷内さんに相談する");
  const edited2 = setSceneTelopText(edited, scenes[1].id, "相談してから決める");
  const edited3 = setSceneTelopText(edited2, scenes[2].id, "特に関係ない文章");
  assert.equal(countTelopOccurrencesInOtherScenes(edited3, scenes[0].id, "相談"), 1, "自分以外で「相談」を含むのはscene1の1箇所");
  assert.equal(countTelopOccurrencesInOtherScenes(edited3, scenes[0].id, "存在しない文字列"), 0);
  assert.equal(countTelopOccurrencesInOtherScenes(edited3, scenes[0].id, ""), 0, "空文字は0件扱い");
});

test("replaceTelopOccurrences: 選択した出現箇所だけ置換され、telopEditedがtrueになる", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 500, 600], ["w3", "う", 1000, 1100]);
  const scenes = initializeScenes({
    words: testWords,
    keepSegments: [
      { startMs: 0, endMs: 100 },
      { startMs: 500, endMs: 600 },
      { startMs: 1000, endMs: 1100 },
    ],
  });
  const edited = setSceneTelopText(scenes, scenes[0].id, "谷内さんに相談する");
  const edited2 = setSceneTelopText(edited, scenes[1].id, "相談してから決める");
  const targets = findTelopOccurrencesInOtherScenes(edited2, scenes[0].id, "相談");
  const replaced = replaceTelopOccurrences(edited2, "相談", "谷内", targets);
  assert.equal(replaced[0].telopText, "谷内さんに相談する", "編集中の当該シーン自身は変更されない");
  assert.equal(replaced[1].telopText, "谷内してから決める", "選択した他シーンは置換される");
  assert.equal(replaced[1].telopEdited, true);
  assert.equal(replaced[2].telopText, scenes[2].telopText, "出現しないシーンは変化しない");
});

test("replaceTelopOccurrences: チェックを外した出現箇所は置換しない", () => {
  const testWords = words(["w1", "あ", 0, 100], ["w2", "い", 500, 600]);
  const scenes = initializeScenes({
    words: testWords,
    keepSegments: [
      { startMs: 0, endMs: 100 },
      { startMs: 500, endMs: 600 },
    ],
  });
  const edited = setSceneTelopText(scenes, scenes[0].id, "難下の相談");
  const edited2 = setSceneTelopText(edited, scenes[1].id, "相談と難下");
  const targets = findTelopOccurrencesInOtherScenes(edited2, scenes[0].id, "難下").slice(0, 0);
  const replaced = replaceTelopOccurrences(edited2, "難下", "難化", targets);
  assert.equal(replaced[1].telopText, "相談と難下", "選択0件なら他シーンは変化しない");
});

test("initializeScenes: wordsから組み立てるtelopTextは句点「。」を除去する(改善10-B-3)", () => {
  const testWords = words(["w1", "今回", 0, 100], ["w2", "は", 100, 150], ["w3", "。", 150, 160]);
  const scenes = initializeScenes({
    words: testWords,
    keepSegments: [{ startMs: 0, endMs: 200 }],
  });
  assert.equal(scenes[0].telopText, "今回は");
});

test("initializeScenes: telopPageBoundaries.textがあればパイプライン本文をtelopTextの正とする", () => {
  const testWords = words(["w1", "今回", 0, 100], ["w2", "は", 100, 150], ["w3", "。", 150, 160]);
  const scenes = initializeScenes({
    words: testWords,
    keepSegments: [{ startMs: 0, endMs: 200 }],
    telopPageBoundaries: [{ startMs: 0, endMs: 200, text: "今回はこちら見てください" }],
  });
  assert.equal(scenes[0].telopText, "今回はこちら見てください");
});

// --- runs/20260428_test の実データからscenesを初期化できることを確認する ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.resolve(__dirname, "../../runs/20260428_test");

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

test("runs/20260428_test の実データからscenesを初期化できる", () => {
  const sttPath = path.join(runDir, "step02_stt", "stt_result.json");
  const proposalPath = path.join(runDir, "step07_cut_proposal", "cut_proposal.json");
  assert.ok(fs.existsSync(sttPath), "stt_result.json が見つかりません");
  assert.ok(fs.existsSync(proposalPath), "cut_proposal.json が見つかりません");

  const stt = readJson(sttPath);
  const proposal = readJson(proposalPath);

  const testWords: SourceWord[] = stt.words.map((word: any) => ({
    id: String(word.id),
    text: String(word.text || ""),
    startMs: Number(word.start_ms || 0),
    endMs: Number(word.end_ms || 0),
  }));
  const sentences: SourceSentence[] = (stt.sentences || []).map((sentence: any) => ({
    id: String(sentence.id),
    wordIds: (sentence.word_ids || []).map(String),
    startMs: Number(sentence.start_ms || 0),
    endMs: Number(sentence.end_ms || 0),
  }));
  const keepSegments = proposal.keep_segments.map((segment: any) => ({
    startMs: Number(segment.start_ms || 0),
    endMs: Number(segment.end_ms || 0),
  }));

  const scenes = initializeScenes({ words: testWords, sentences, keepSegments });

  assert.ok(scenes.length >= keepSegments.length, "少なくともkeep_segmentsの数だけシーンがあるはず");
  for (const scene of scenes) {
    assert.ok(scene.words.length > 0, "各シーンは少なくとも1単語を持つ");
    assert.ok(scene.sourceEndMs > scene.sourceStartMs);
    assert.equal(scene.telopEdited, false);
    assert.equal(scene.telopText, scene.words.map((w) => w.text).join("").replace(/。/g, ""));
  }

  // 編集を一切行っていないため、導出したkeep_segmentsは元のcut_proposalと一致するはず。
  const rebuilt = deriveKeepSegments(scenes);
  assert.equal(rebuilt.length, keepSegments.length);
  rebuilt.forEach((segment, index) => {
    assert.equal(segment.startMs, keepSegments[index].startMs);
    assert.equal(segment.endMs, keepSegments[index].endMs);
  });

  // 疑義キューと紐づけても例外が起きず、少なくとも1シーンに紐づくことを確認する。
  const suspicions = buildSuspicionQueue({ words: testWords.map((w) => ({ ...w, confidence: 0 })), keepSegments });
  const bindings = attachSuspicionsToScenes(scenes, suspicions);
  assert.ok(bindings.size > 0);

  // 改善2(シーン行の分割位置を自然に)の実例確認: 3番目のkeep_segment
  // 「自動編集です。こうやって間があってもカットできるかテストしてます。」(33文字)は、
  // 句読点分割で「自動編集です。」と26文字の文に分かれた後、後者がさらに全角24文字上限を超えるため
  // 助詞「も」の直後で「こうやって間があっても」/「カットできるかテストしてます。」に再分割される。
  // 結果としてkeep_segmentの数(3)より多い6シーンになる(旧アルゴリズムでは5シーンだった)。
  // なお2番目の「の字幕やカットの」の先頭「の」は、単語「の」(w-0011)がkeep_segment1と2の両方に
  // わずかに重なる(word.startMs<segment.endMs && word.endMs>segment.startMsの判定による)という
  // 既存の(本タスクとは無関係な)境界重複挙動によるもので、初期化アルゴリズムの変更前から存在する。
  const telopTexts = scenes.map((scene) => scene.telopText);
  assert.equal(scenes.length, 6, "改善2の行分割規則により6シーンに分かれるはず");
  assert.deepEqual(telopTexts, [
    "こんにちは",
    "これは動画の",
    "の字幕やカットの",
    "自動編集です",
    "こうやって間があっても",
    "カットできるかテストしてます",
  ]);
});

// =============================================================================
// W10-7(相槌・極短シーンのテロップ空欄化): 正規化後2文字以下 or フィラーのみのシーンは
// 初期telopTextを空欄にする(words・尺は残す。telopEditedは立てない)。
// =============================================================================

test("initializeScenes: フィラーのみのシーンは初期telopTextが空欄になる(W10-7)", () => {
  const testWords = words(
    ["w1", "え", 0, 100, "s1"],
    ["w2", "っ", 100, 200, "s1"],
    ["w3", "と", 200, 300, "s1"],
    ["w4", "こんにちは皆さん", 400, 1200, "s2"],
  );
  const sentences: SourceSentence[] = [
    { id: "s1", wordIds: ["w1", "w2", "w3"], startMs: 0, endMs: 300 },
    { id: "s2", wordIds: ["w4"], startMs: 400, endMs: 1200 },
  ];
  const scenes = initializeScenes({
    words: testWords,
    sentences,
    keepSegments: [
      { startMs: 0, endMs: 300 },
      { startMs: 400, endMs: 1200 },
    ],
  });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].telopText, "", "「えっと」はフィラーのみなので空欄");
  assert.equal(scenes[0].telopEdited, false, "空欄化は初期値の扱いでtelopEditedは立てない");
  assert.equal(scenes[0].words.length, 3, "wordsと尺はそのまま残る");
  assert.equal(scenes[1].telopText, "こんにちは皆さん", "通常の長さのシーンは従来どおり");
});

// =============================================================================
// W10-4(分割時のテロップ文言分配): splitEditedTelopText
// =============================================================================

/** テスト用: 1文字ずつのSceneWordを組み立てる(時刻はダミー連番)。 */
function sceneWords(chars: string[], deletedChars: string[] = []): SceneWord[] {
  return chars.map((text, index) => ({
    id: `sw${index}_${text}`,
    text,
    startMs: index * 100,
    endMs: (index + 1) * 100,
    deleted: deletedChars.includes(text),
  }));
}

test("splitEditedTelopText: 後半wordsの先頭列が編集文中に見つかればそこで分割する(一致探索)", () => {
  // ユーザーが句点を追加した編集文。後半words「今日はいい天気です」の接頭辞
  // 「今日はいい天気」が(正規化一致で)見つかるので、その直前で分割される。
  const result = splitEditedTelopText(
    "こんにちは。今日はいい天気",
    sceneWords(["こ", "ん", "に", "ち", "は"]),
    sceneWords(["今", "日", "は", "い", "い", "天", "気", "で", "す"]),
  );
  assert.equal(result.first, "こんにちは。");
  assert.equal(result.second, "今日はいい天気");
});

test("splitEditedTelopText: 同じ語が2回出る場合は最後の出現位置で分割する", () => {
  const result = splitEditedTelopText(
    "また今度、また明日",
    sceneWords(["そ", "れ", "で", "は"]),
    sceneWords(["ま", "た", "明", "日"]),
  );
  assert.equal(result.first, "また今度、");
  assert.equal(result.second, "また明日");
});

test("splitEditedTelopText: 一致しなければ前半words比率で分割し、後半に残りを全て割当する(W10-12)", () => {
  // words("ナ"x5 / "マ"x5)はどちらも編集文に現れない→比率(5:5)フォールバック。
  const result = splitEditedTelopText(
    "あいうえお かきくけこ",
    sceneWords(["ナ", "ナ", "ナ", "ナ", "ナ"]),
    sceneWords(["マ", "マ", "マ", "マ", "マ"]),
  );
  assert.equal(result.first, "あいうえお");
  assert.equal(result.second, "かきくけこ");
});

test("splitEditedTelopText: 比率フォールバックは助詞スナップなしで文字数比のみ(W10-12)", () => {
  const result = splitEditedTelopText(
    "今日は晴れました",
    sceneWords(["ナ", "ナ", "ナ"]),
    sceneWords(["マ", "マ", "マ", "マ", "マ"]),
  );
  assert.equal(result.first, "今日は");
  assert.equal(result.second, "晴れました");
});

test("splitEditedTelopText: どちらの半分にも全文が複製されない", () => {
  const edited = "編集済みの長いテロップ文言です";
  const result = splitEditedTelopText(
    edited,
    sceneWords(["ナ", "ナ", "ナ", "ナ"]),
    sceneWords(["マ", "マ", "マ", "マ"]),
  );
  assert.notEqual(result.first, edited);
  assert.notEqual(result.second, edited);
  assert.equal((result.first + result.second).replace(/\s/g, ""), edited.replace(/\s/g, ""));
});

test("splitSceneAtWord: 編集済みシーンの分割で一致探索が効くと両側に正しい文言が残る(W10-4)", () => {
  // words「おはようございます」を前半「おはよう」/後半「ございます」で分割。
  // 編集文にも「ございます」がそのまま含まれるため一致探索で正確に分かれる。
  const testWords = words(
    ["w1", "お", 0, 100],
    ["w2", "は", 100, 200],
    ["w3", "よ", 200, 300],
    ["w4", "う", 300, 400],
    ["w5", "ご", 400, 500],
    ["w6", "ざ", 500, 600],
    ["w7", "い", 600, 700],
    ["w8", "ま", 700, 800],
    ["w9", "す", 800, 900],
  );
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 900 }] });
  const edited = setSceneTelopText(scenes, scenes[0].id, "おっはよーうございます");
  const split = splitSceneAtWord(edited, edited[0].id, "w5");
  assert.equal(split.length, 2);
  assert.equal(split[0].telopText, "おっはよーう");
  assert.equal(split[1].telopText, "ございます");
  assert.equal(split[0].telopEdited, true);
  assert.equal(split[1].telopEdited, true);
});

test("splitSceneAtWord: 省略編集テキストの分割で後半にautoTelop全文が復活しない(W10-12)", () => {
  const testWords = words(
    ["w1", "今", 0, 100],
    ["w2", "日", 100, 200],
    ["w3", "は", 200, 300],
    ["w4", "晴", 300, 400],
    ["w5", "れ", 400, 500],
    ["w6", "で", 500, 600],
    ["w7", "し", 600, 700],
    ["w8", "た", 700, 800],
  );
  const scenes = initializeScenes({ words: testWords, keepSegments: [{ startMs: 0, endMs: 800 }] });
  const edited = setSceneTelopText(scenes, scenes[0].id, "晴れ");
  const split = splitSceneAtWord(edited, edited[0].id, "w5");
  assert.equal(split.length, 2);
  assert.equal(split[0].telopEdited, true);
  assert.equal(split[1].telopEdited, true);
  assert.notEqual(split[0].telopText, "今日は晴");
  assert.notEqual(split[1].telopText, "れでした");
  assert.notEqual(split[1].telopText, autoTelopTextFromWords(split[1].words));
});

// =============================================================================
// W10-1(シーン単位の削除・復元): isSceneFullyDeleted / findNextSelectionAfterSceneDelete
// =============================================================================

function sceneStub(id: string, allDeleted: boolean): Scene {
  return {
    id,
    sourceStartMs: 0,
    sourceEndMs: 100,
    words: [
      { id: `${id}_w1`, text: "あ", startMs: 0, endMs: 50, deleted: allDeleted },
      { id: `${id}_w2`, text: "い", startMs: 50, endMs: 100, deleted: allDeleted },
    ],
    telopText: "あい",
    telopEdited: false,
    cutMarks: [],
  };
}

test("isSceneFullyDeleted: 全単語deletedのときだけtrue", () => {
  assert.equal(isSceneFullyDeleted(sceneStub("s1", true)), true);
  assert.equal(isSceneFullyDeleted(sceneStub("s2", false)), false);
  const partial = sceneStub("s3", false);
  partial.words[0].deleted = true;
  assert.equal(isSceneFullyDeleted(partial), false);
});

test("findNextSelectionAfterSceneDelete: 直前の未削除シーンを優先し、削除済みはスキップする", () => {
  const scenes = [sceneStub("a", false), sceneStub("b", true), sceneStub("c", false), sceneStub("d", false)];
  // cを削除→直前bは削除済みなのでスキップしてaへ。
  assert.equal(findNextSelectionAfterSceneDelete(scenes, 2), "a");
});

test("findNextSelectionAfterSceneDelete: 先頭シーン削除時は次の未削除シーンへ、全滅ならnull", () => {
  const scenes = [sceneStub("a", false), sceneStub("b", true), sceneStub("c", false)];
  assert.equal(findNextSelectionAfterSceneDelete(scenes, 0), "c");
  const allDeleted = [sceneStub("a", true), sceneStub("b", true)];
  assert.equal(findNextSelectionAfterSceneDelete(allDeleted, 0), null);
});

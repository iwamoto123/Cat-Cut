import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWordGroups,
  buildWordGroupsUncached,
  findActiveGroupId,
  findBoundaryGroupIndex,
  findGroupByWordId,
  msFromGroupBoundaryIndex,
  nearestGroupBoundaryIndex,
  normalizeChipDragRange,
  wordIdsForGroupRange,
} from "../src/lib/wordGroups.ts";
import { initializeScenes, resetSceneIdCounterForTests, type Scene, type SceneWord, type SourceWord } from "../src/lib/scenes.ts";

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

/** テスト用: 1文字ずつのSceneWordを組み立てる(startMs/endMsは100msずつ連番)。 */
function buildSceneFromChars(sceneId: string, chars: string[], startAtMs = 0): Scene {
  const words: SceneWord[] = chars.map((text, index) => ({
    id: `${sceneId}_w${index}`,
    text,
    startMs: startAtMs + index * 100,
    endMs: startAtMs + (index + 1) * 100,
    deleted: false,
  }));
  return {
    id: sceneId,
    sourceStartMs: words[0]?.startMs ?? startAtMs,
    sourceEndMs: words[words.length - 1]?.endMs ?? startAtMs,
    words,
    telopText: chars.join(""),
    telopEdited: false,
    cutMarks: [],
  };
}

// 仕様書「改善1」節の例そのもの: 「相談できる相手も」を一文字ずつのSceneWordに分解し、
// 「相談」「できる」「相手」「も」の4グループに束ねられることを確認する。
test("buildWordGroups: 「相談できる相手も」を形態素的な単語グループに束ねる(仕様書の例)", () => {
  const scene = buildSceneFromChars("s1", ["相", "談", "で", "き", "る", "相", "手", "も"]);
  const groups = buildWordGroups(scene);
  assert.deepEqual(
    groups.map((g) => g.text),
    ["相談", "できる", "相手", "も"],
  );
});

test("buildWordGroups: グループの時間は先頭文字のstartMs〜末尾文字のendMs", () => {
  const scene = buildSceneFromChars("s1", ["相", "談", "で", "き", "る", "相", "手", "も"]);
  const groups = buildWordGroups(scene);
  // 「できる」= で(200-300)/き(300-400)/る(400-500) -> 200〜500
  const dekiru = groups.find((g) => g.text === "できる");
  assert.equal(dekiru?.startMs, 200);
  assert.equal(dekiru?.endMs, 500);
  // 「相談」= 相(0-100)/談(100-200) -> 0〜200
  const soudan = groups.find((g) => g.text === "相談");
  assert.equal(soudan?.startMs, 0);
  assert.equal(soudan?.endMs, 200);
});

test("buildWordGroups: グループはシーン内の全文字wordをちょうど1回ずつ含む(欠落・重複なし)", () => {
  const scene = buildSceneFromChars("s1", ["相", "談", "で", "き", "る", "相", "手", "も"]);
  const groups = buildWordGroups(scene);
  const allWordIds = groups.flatMap((g) => g.wordIds);
  assert.deepEqual(allWordIds, scene.words.map((w) => w.id), "出現順を保って全word idを1回ずつ含む");
});

test("buildWordGroups: 句読点(非単語トークン)は直前のグループへ結合される", () => {
  // 「です。」-> で/す/。 の3文字wordが「です。」という1つのグループになる。
  const scene = buildSceneFromChars("s1", ["で", "す", "。"]);
  const groups = buildWordGroups(scene);
  assert.deepEqual(
    groups.map((g) => g.text),
    ["です。"],
  );
  assert.deepEqual(groups[0].wordIds, ["s1_w0", "s1_w1", "s1_w2"]);
});

test("buildWordGroups: 文頭の記号など直前グループが無い非単語トークンは単独のグループになる", () => {
  const scene = buildSceneFromChars("s1", ["、", "あ"]);
  const groups = buildWordGroups(scene);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].text, "、");
  assert.equal(groups[1].text, "あ");
});

test("buildWordGroups: deletedはメンバー全員がdeletedのときだけtrue", () => {
  const scene = buildSceneFromChars("s1", ["で", "き", "る"]);
  const dekiruGroup = () => buildWordGroupsUncached(scene).find((g) => g.text === "できる")!;

  assert.equal(dekiruGroup().deleted, false, "誰も削除していない場合はfalse");

  const partiallyDeleted: Scene = {
    ...scene,
    words: scene.words.map((w, i) => (i === 0 ? { ...w, deleted: true } : w)),
  };
  assert.equal(
    buildWordGroupsUncached(partiallyDeleted).find((g) => g.text === "できる")?.deleted,
    false,
    "一部だけ削除されている間はfalse",
  );

  const fullyDeleted: Scene = {
    ...scene,
    words: scene.words.map((w) => ({ ...w, deleted: true })),
  };
  assert.equal(
    buildWordGroupsUncached(fullyDeleted).find((g) => g.text === "できる")?.deleted,
    true,
    "全員削除されるとtrue",
  );
});

test("buildWordGroups: autoTrimmedはメンバー全員がdeletedかつautoTrimmedのときだけtrue", () => {
  const scene = buildSceneFromChars("s1", ["で", "き", "る"]);
  const allAutoTrimmed: Scene = {
    ...scene,
    words: scene.words.map((w) => ({ ...w, deleted: true, autoTrimmed: true })),
  };
  assert.equal(buildWordGroupsUncached(allAutoTrimmed)[0].autoTrimmed, true);

  const mixedTrim: Scene = {
    ...scene,
    words: scene.words.map((w, i) => ({ ...w, deleted: true, autoTrimmed: i !== 0 })),
  };
  assert.equal(
    buildWordGroupsUncached(mixedTrim)[0].autoTrimmed,
    false,
    "1文字でも手動削除(autoTrimmedでない)が混ざればfalse",
  );
});

test("buildWordGroups: 同一シーン参照であればメモ化により同一配列インスタンスを返す", () => {
  const scene = buildSceneFromChars("s1", ["あ", "い", "う"]);
  const first = buildWordGroups(scene);
  const second = buildWordGroups(scene);
  assert.equal(first, second, "同じsceneオブジェクト参照に対しては再計算せずキャッシュを返す");

  // 内容が変わった(=新しいscenceオブジェクトになった)場合は再計算される。
  const mutatedScene: Scene = { ...scene, words: [...scene.words] };
  const third = buildWordGroups(mutatedScene);
  assert.notEqual(first, third, "新しいsceneオブジェクトには新しい配列を返す(取り違えない)");
  assert.deepEqual(
    first.map((g) => g.text),
    third.map((g) => g.text),
    "内容(グループ分割結果)自体は変わらない",
  );
});

test("findBoundaryGroupIndex: ms位置からグループ境界カーソル(右隣のグループindex)を求める", () => {
  const scene = buildSceneFromChars("s1", ["相", "談", "で", "き", "る", "相", "手", "も"]);
  const groups = buildWordGroups(scene);
  // groups: 相談(0-200) / できる(200-500) / 相手(500-700) / も(700-800)
  assert.equal(findBoundaryGroupIndex(groups, 0), 0);
  assert.equal(findBoundaryGroupIndex(groups, 100), 1, "「相談」の途中は右隣が「できる」になる");
  assert.equal(findBoundaryGroupIndex(groups, 200), 1);
  assert.equal(findBoundaryGroupIndex(groups, 800), 4, "末尾より後ろは境界なし(groups.length)");
});

test("findGroupByWordId: 指定した文字wordIdを含むグループを引ける", () => {
  const scene = buildSceneFromChars("s1", ["相", "談", "で", "き", "る"]);
  const groups = buildWordGroups(scene);
  assert.equal(findGroupByWordId(groups, "s1_w3")?.text, "できる", "「き」はできるグループに属する");
  assert.equal(findGroupByWordId(groups, "not-exist"), null);
});

// --- 改善3(チップ間ホバーキャレット) ---
// 旧実装(改善1)の`nearestGroupBoundaryMs`(クリック時にそのグループの端へシーク)と
// `msFromGroupHoverPosition`(ホバー中にグループ内を時間軸で線形補間してシーク)は、
// 改善3でチップ間キャレット方式(境界インデックスベース、クリックで確定)に置き換えられたため、
// 対応するテストも新関数(nearestGroupBoundaryIndex/msFromGroupBoundaryIndex)のテストへ差し替えた。

test("nearestGroupBoundaryIndex: ホバー位置がチップの左半分/右半分かで境界インデックスを切り替える", () => {
  assert.equal(nearestGroupBoundaryIndex(1, 10, 100), 1, "左半分は自分自身の左境界(chipIndex)");
  assert.equal(nearestGroupBoundaryIndex(1, 90, 100), 2, "右半分は右境界(chipIndex+1)");
  assert.equal(nearestGroupBoundaryIndex(1, 50, 100), 2, "ちょうど中央は右境界扱い(50 < 50は偽)");
});

test("msFromGroupBoundaryIndex: 境界インデックスからmsへ変換する(findAdjacentGroupBoundaryMsと同じ規則)", () => {
  const scene = buildSceneFromChars("s1", ["相", "談", "で", "き", "る", "相", "手", "も"]);
  const groups = buildWordGroups(scene);
  // groups: 相談(0-200) / できる(200-500) / 相手(500-700) / も(700-800)
  assert.equal(msFromGroupBoundaryIndex(groups, 0), 0, "行頭は先頭グループの開始ms");
  assert.equal(msFromGroupBoundaryIndex(groups, 1), 200, "「相談」と「できる」の間");
  assert.equal(msFromGroupBoundaryIndex(groups, 4), 800, "行末は末尾グループの終了ms");
  assert.equal(msFromGroupBoundaryIndex([], 0), 0, "グループが無ければ0");
});

test("findActiveGroupId: 再生位置msが属するグループのidを返す(改善3の再生中チップハイライト用)", () => {
  const scene = buildSceneFromChars("s1", ["相", "談", "で", "き", "る", "相", "手", "も"]);
  const groups = buildWordGroups(scene);
  const soudan = groups.find((g) => g.text === "相談")!;
  const dekiru = groups.find((g) => g.text === "できる")!;
  assert.equal(findActiveGroupId(groups, 0), soudan.id, "先頭ちょうどは先頭グループ");
  assert.equal(findActiveGroupId(groups, 150), soudan.id, "グループの途中はそのグループ");
  assert.equal(findActiveGroupId(groups, 200), dekiru.id, "次グループの開始ちょうどは次グループ");
  assert.equal(findActiveGroupId(groups, 800), null, "末尾グループのendMsちょうどは半開区間なので該当なし");
  assert.equal(findActiveGroupId(groups, 10000), null, "範囲外はnull");
});

// --- runs/20260428_test の実データでのグループ化検証 ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.resolve(__dirname, "../../runs/20260428_test");

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function loadRealScenes(): Scene[] {
  const stt = readJson(path.join(runDir, "step02_stt", "stt_result.json"));
  const proposal = readJson(path.join(runDir, "step07_cut_proposal", "cut_proposal.json"));
  const testWords: SourceWord[] = stt.words.map((word: any) => ({
    id: String(word.id),
    text: String(word.text || ""),
    startMs: Number(word.start_ms || 0),
    endMs: Number(word.end_ms || 0),
  }));
  const sentences = (stt.sentences || []).map((sentence: any) => ({
    id: String(sentence.id),
    wordIds: (sentence.word_ids || []).map(String),
    startMs: Number(sentence.start_ms || 0),
    endMs: Number(sentence.end_ms || 0),
  }));
  const keepSegments = proposal.keep_segments.map((segment: any) => ({
    startMs: Number(segment.start_ms || 0),
    endMs: Number(segment.end_ms || 0),
  }));
  return initializeScenes({ words: testWords, sentences, keepSegments });
}

test("runs/20260428_test の実データでグループ化しても文字の欠落・重複が起きない", () => {
  const scenes = loadRealScenes();
  assert.ok(scenes.length > 0);
  for (const scene of scenes) {
    const groups = buildWordGroups(scene);
    // 全グループのテキストを連結すると、元のシーンの文字列(単語連結)と一致する。
    assert.equal(groups.map((g) => g.text).join(""), scene.words.map((w) => w.text).join(""));
    // 全グループのwordIdを連結すると、シーンの単語id列とちょうど1回ずつ・同じ順序で一致する。
    assert.deepEqual(groups.flatMap((g) => g.wordIds), scene.words.map((w) => w.id));
    // グループ数は文字数以下(1文字1グループが最大に細かい状態)。
    assert.ok(groups.length <= scene.words.length);
    for (const group of groups) {
      assert.ok(group.endMs >= group.startMs);
      assert.equal(group.deleted, false, "初期状態はどのwordも削除されていない");
    }
  }
});

test("runs/20260428_test: 「こんにちは。」は句点まで含めて1つのグループになる", () => {
  const scenes = loadRealScenes();
  const greetingScene = scenes.find((scene) => scene.words.map((w) => w.text).join("") === "こんにちは。");
  assert.ok(greetingScene, "「こんにちは。」のシーンが見つかること");
  const groups = buildWordGroups(greetingScene!);
  assert.deepEqual(
    groups.map((g) => g.text),
    ["こんにちは。"],
  );
});

// --- 改善5-2(チップのドラッグ複数選択) ---

test("normalizeChipDragRange: 開始index〜現在indexの範囲を順序に関係なく正規化する", () => {
  assert.deepEqual(normalizeChipDragRange(1, 3), { start: 1, end: 3 }, "順方向ドラッグ");
  assert.deepEqual(normalizeChipDragRange(3, 1), { start: 1, end: 3 }, "逆方向ドラッグでも同じ範囲になる");
  assert.deepEqual(normalizeChipDragRange(2, 2), { start: 2, end: 2 }, "同じチップ上ならその1つだけの範囲");
});

test("wordIdsForGroupRange: 範囲内(両端含む)の全グループのwordIdを出現順で返す", () => {
  const scene = buildSceneFromChars("s1", ["相", "談", "で", "き", "る", "相", "手", "も"]);
  const groups = buildWordGroups(scene);
  // groups: 相談(0) / できる(1) / 相手(2) / も(3)
  assert.deepEqual(
    wordIdsForGroupRange(groups, 0, 1),
    ["s1_w0", "s1_w1", "s1_w2", "s1_w3", "s1_w4"],
    "「相談」+「できる」の全文字",
  );
  assert.deepEqual(wordIdsForGroupRange(groups, 2, 2), ["s1_w5", "s1_w6"], "単一グループ範囲");
});

test("wordIdsForGroupRange: 範囲外のindexは配列の境界にクランプする", () => {
  const scene = buildSceneFromChars("s1", ["相", "談", "で", "き", "る"]);
  const groups = buildWordGroups(scene);
  assert.deepEqual(wordIdsForGroupRange(groups, -5, 100), scene.words.map((w) => w.id), "範囲外指定は全件になる");
  assert.deepEqual(wordIdsForGroupRange([], 0, 3), [], "グループが無ければ空配列");
});

test("runs/20260428_test: 「自動編集です。」は「自動」「編集」「です。」の3グループに分かれる", () => {
  const scenes = loadRealScenes();
  const scene = scenes.find((s) => s.words.map((w) => w.text).join("") === "自動編集です。");
  assert.ok(scene, "「自動編集です。」のシーンが見つかること");
  const groups = buildWordGroups(scene!);
  assert.deepEqual(
    groups.map((g) => g.text),
    ["自動", "編集", "です。"],
  );
});

// W14-2: 編集前→編集後の語レベル修正ペア抽出(extractCorrectionPairs)と
// 修正履歴に基づく既知の誤表記検出(findKnownWrongNotations)のテスト。
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCorrectionPairs,
  findKnownWrongNotations,
} from "../src/lib/correctionPairs.ts";

// --- extractCorrectionPairs ---

test("W14-2 extractCorrectionPairs: 単語1つの置換を語ペアとして抽出する", () => {
  // Intl.Segmenterは「平谷塾」を「平谷」+「塾」に分割するため、変化した語部分だけがペアになる
  const pairs = extractCorrectionPairs("平谷塾で勉強しています", "白谷塾で勉強しています");
  assert.deepEqual(pairs, [{ before: "平谷", after: "白谷" }]);
});

test("W14-2 extractCorrectionPairs: 離れた複数の変更をそれぞれのペアとして抽出する", () => {
  const pairs = extractCorrectionPairs(
    "マスターリサプリで勉強して協定を受けます",
    "スタディサプリで勉強して共テを受けます",
  );
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[0], { before: "マスターリサプリ", after: "スタディサプリ" });
  assert.deepEqual(pairs[1], { before: "協定", after: "共テ" });
});

test("W14-2 extractCorrectionPairs: 変更なしは空", () => {
  assert.deepEqual(extractCorrectionPairs("同じテキスト", "同じテキスト"), []);
});

test("W14-2 extractCorrectionPairs: 1〜2文字のひらがな(助詞)だけの変更は記録しない", () => {
  assert.deepEqual(extractCorrectionPairs("数学が得意です", "数学は得意です"), []);
  assert.deepEqual(extractCorrectionPairs("学校にも行きます", "学校でも行きます"), []);
});

test("W14-2 extractCorrectionPairs: 空白・改行のみの変更は記録しない", () => {
  assert.deepEqual(extractCorrectionPairs("今日は いい天気", "今日はいい天気"), []);
  assert.deepEqual(extractCorrectionPairs("今日は\nいい天気", "今日はいい\n天気"), []);
});

test("W14-2 extractCorrectionPairs: 純粋な挿入・削除(片側が空)はペアにしない", () => {
  assert.deepEqual(extractCorrectionPairs("数学をやります", "数学を毎日やります"), []);
  assert.deepEqual(extractCorrectionPairs("数学を毎日やります", "数学をやります"), []);
});

test("W14-2 extractCorrectionPairs: 20文字を超える差分(文の書き換え)はペアにしない", () => {
  const before = "この参考書はとても難しくて全然進みませんでした";
  const after = "别の教材へ乗り換えたところ毎日楽しく学習を継続できています";
  assert.deepEqual(extractCorrectionPairs(before, after), []);
});

test("W14-2 extractCorrectionPairs: 漢字2文字の誤変換修正は記録する(ひらがな限定の除外に該当しない)", () => {
  const pairs = extractCorrectionPairs("勇気化学を学ぶ", "有機化学を学ぶ");
  assert.deepEqual(pairs, [{ before: "勇気", after: "有機" }]);
});

// --- findKnownWrongNotations ---

test("W14-2 findKnownWrongNotations: 頻出(count>=2)の誤表記が残っていれば検出する", () => {
  const history = [{ before: "平谷塾", after: "白谷塾", count: 3 }];
  const found = findKnownWrongNotations("今日も平谷塾で頑張ります", history);
  assert.deepEqual(found, [{ before: "平谷塾", after: "白谷塾", count: 3 }]);
});

test("W14-2 findKnownWrongNotations: count=1(頻出でない)は検出しない", () => {
  const history = [{ before: "平谷塾", after: "白谷塾", count: 1 }];
  assert.deepEqual(findKnownWrongNotations("今日も平谷塾で頑張ります", history), []);
});

test("W14-2 findKnownWrongNotations: 誤が正の部分文字列でも正表記だけなら誤検出しない", () => {
  const history = [{ before: "白谷", after: "白谷塾", count: 5 }];
  assert.deepEqual(findKnownWrongNotations("白谷塾で頑張ります", history), []);
  const found = findKnownWrongNotations("白谷で頑張ります", history);
  assert.equal(found.length, 1);
  assert.equal(found[0].before, "白谷");
});

test("W14-2 findKnownWrongNotations: 1文字の誤・履歴なし・空テキストは検出しない", () => {
  assert.deepEqual(
    findKnownWrongNotations("あいうえお", [{ before: "あ", after: "案", count: 9 }]),
    [],
  );
  assert.deepEqual(findKnownWrongNotations("テキスト", []), []);
  assert.deepEqual(findKnownWrongNotations("テキスト", undefined), []);
  assert.deepEqual(
    findKnownWrongNotations("", [{ before: "平谷塾", after: "白谷塾", count: 3 }]),
    [],
  );
});

test("W14-2 findKnownWrongNotations: 頻度降順で返し同一beforeは1件に絞る", () => {
  const history = [
    { before: "協定", after: "共テ", count: 2 },
    { before: "平谷塾", after: "白谷塾", count: 5 },
    { before: "平谷塾", after: "白谷ゼミ", count: 3 },
  ];
  const found = findKnownWrongNotations("平谷塾の協定対策です", history);
  assert.deepEqual(found, [
    { before: "平谷塾", after: "白谷塾", count: 5 },
    { before: "協定", after: "共テ", count: 2 },
  ]);
});

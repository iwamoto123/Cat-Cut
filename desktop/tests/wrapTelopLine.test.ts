import test from "node:test";
import assert from "node:assert/strict";
import { weightedTelopLineLength, wrapTelopLine } from "../src/lib/wrapTelopLine.ts";
import { isBadLineBreak } from "../src/lib/telopLineBreak.ts";

/**
 * 改善20-B(行バジェット超過時の明示的な改行位置制御)のテスト。
 * wrapTelopLine は Intl.Segmenter('ja', word) の語境界のみで折り返す純関数。
 * Node 22 は Intl.Segmenter を実装しているため、実UI(Chromium)と同じ経路で検証できる。
 */

test("wrapTelopLine: バジェット以内のテキストはそのまま1行で返す", () => {
  assert.deepEqual(wrapTelopLine("こんにちは", 16), ["こんにちは"]);
});

test("wrapTelopLine: 空文字は空配列を返す", () => {
  assert.deepEqual(wrapTelopLine("", 16), []);
});

test("wrapTelopLine: バジェットが不正(0以下)なら折り返さない", () => {
  assert.deepEqual(wrapTelopLine("あいうえお", 0), ["あいうえお"]);
});

test("wrapTelopLine: 検品ケース「インスタなのかYouTubeなのかXなのかいろいろ」が語境界で分かれる", () => {
  const lines = wrapTelopLine("インスタなのかYouTubeなのかXなのかいろいろ", 16);
  assert.ok(lines.length >= 2, `2行以上に折り返される: ${JSON.stringify(lines)}`);
  // 復元可能(文字の欠落・追加がない)
  assert.equal(lines.join(""), "インスタなのかYouTubeなのかXなのかいろいろ");
  // 各行がバジェット以内(重み付き文字数)
  for (const line of lines) {
    assert.ok(
      weightedTelopLineLength(line) <= 16,
      `行バジェット超過: ${line} (${weightedTelopLineLength(line)})`,
    );
  }
  // 英数字連(YouTube)の内部で分断されない
  assert.ok(
    lines.some((line) => line.includes("YouTube")),
    `YouTubeが分断された: ${JSON.stringify(lines)}`,
  );
});

test("wrapTelopLine: 折返し行の先頭が句読点にならない(行頭禁則)", () => {
  const lines = wrapTelopLine("これはテストです、そして次の文章がとても長く続いています", 12);
  for (const line of lines.slice(1)) {
    assert.ok(!"、。！？!?…".includes(line[0]), `行頭禁則違反: ${JSON.stringify(lines)}`);
  }
});

test("wrapTelopLine: バジェットを超える単一の英単語は無理に文字分割しない", () => {
  const lines = wrapTelopLine("supercalifragilisticexpialidocious", 12);
  assert.deepEqual(lines, ["supercalifragilisticexpialidocious"]);
});

test("wrapTelopLine: 2行のバランスが極端に偏らない", () => {
  const lines = wrapTelopLine("インスタなのかYouTubeなのかXなのかいろいろ", 16);
  const widths = lines.map(weightedTelopLineLength);
  const max = Math.max(...widths);
  const min = Math.min(...widths);
  // 「1文字だけの行」のような極端な分割にならない
  assert.ok(min >= max * 0.3, `バランスが悪い分割: ${JSON.stringify(lines)}`);
});

test("weightedTelopLineLength: 全角=1.0、半角英数=0.55で計算する", () => {
  assert.equal(weightedTelopLineLength("あい"), 2);
  assert.ok(Math.abs(weightedTelopLineLength("ab") - 1.1) < 1e-9);
});

// --- フェーズT2.5-1: maxLines(最大行数)制約 ---

test("wrapTelopLine maxLines: 3行以上になる長文もmaxLines=2以内へ再折返しする", () => {
  const text = "チャンネル登録者数がたった3ヶ月で10万人を突破した本当の理由を全部話します";
  const unlimited = wrapTelopLine(text, 12);
  assert.ok(unlimited.length >= 3, `前提: 制約なしでは3行以上 (${unlimited.length}行)`);
  const limited = wrapTelopLine(text, 12, 2);
  assert.ok(limited.length <= 2, `2行以内: ${JSON.stringify(limited)}`);
  assert.equal(limited.join(""), text, "文字の欠落・追加がない");
});

test("wrapTelopLine maxLines: バジェット以内・maxLines以内なら結果は変わらない", () => {
  assert.deepEqual(wrapTelopLine("こんにちは", 16, 2), ["こんにちは"]);
  const text = "インスタなのかYouTubeなのかXなのかいろいろ";
  assert.deepEqual(wrapTelopLine(text, 16, 2), wrapTelopLine(text, 16));
});

// --- 実機FB(名詞＋助詞の間で改行される)対応: 行頭に付属語を置かない ---

test("wrapTelopLine: 名詞と助詞の間で折り返さない", () => {
  const cases: Array<[string, number]> = [
    ["第1回ベネッセ駿台共通テスト模試を受けられると思うんですけども", 12],
    ["いろんな共通テスト対策の動画を上げています", 12],
    ["高校3年生まで野球部でキャプテンをしてて", 12],
    ["私の個人LINEのこう追加のページが出てくるので", 12],
  ];
  for (const [text, budget] of cases) {
    const lines = wrapTelopLine(text, budget, 2);
    assert.equal(lines.join(""), text);
    for (let index = 1; index < lines.length; index += 1) {
      const before = lines.slice(0, index).join("");
      assert.ok(
        !isBadLineBreak(before, lines[index]),
        `付属語が行頭に来ている: ${JSON.stringify(lines)}`,
      );
    }
  }
});

test("wrapTelopLine: 「模試を / 受けられる」のように文節末で折り返す", () => {
  const lines = wrapTelopLine("第1回ベネッセ駿台共通テスト模試を受けられると思うんですけども", 12, 2);
  assert.deepEqual(lines, ["第1回ベネッセ駿台共通テスト模試を", "受けられると思うんですけども"]);
});

test("wrapTelopLine: 名詞+補助動詞(担当+して)の間で折り返さない", () => {
  const lines = wrapTelopLine("私が国語の共通テスト対策担当してまして", 12, 2);
  assert.ok(
    lines.every((line) => !line.startsWith("して")),
    `付属語が行頭に来ている: ${JSON.stringify(lines)}`,
  );
});

test("wrapTelopLine maxLines: maxLines=1は必ず1行(幅フィット縮小に委ねる)", () => {
  const lines = wrapTelopLine("これはとても長い文章でバジェットを大きく超えています", 8, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "これはとても長い文章でバジェットを大きく超えています");
});

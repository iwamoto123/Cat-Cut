import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewHotspots,
  detectAwkwardLineBreak,
  detectSceneBoundaryTruncation,
} from "../src/lib/reviewHotspots.ts";
import type { Scene } from "../src/lib/scenes.ts";
import type { SuspicionItem } from "../src/lib/suspicionQueue.ts";

function makeScene(id: string, telopText: string, startMs = 0): Scene {
  const chars = [...telopText.replace(/\n/g, "")];
  return {
    id,
    sourceStartMs: startMs,
    sourceEndMs: startMs + chars.length * 100,
    words: chars.map((ch, index) => ({
      id: `${id}-w${index}`,
      text: ch,
      startMs: startMs + index * 100,
      endMs: startMs + (index + 1) * 100,
      deleted: false,
    })),
    telopText,
    telopEdited: false,
    cutMarks: [],
  };
}

function makeSuspicion(overrides: Partial<SuspicionItem> = {}): SuspicionItem {
  return {
    id: "s1",
    type: "suspect_word",
    severity: "high",
    label: "文脈上あやしい語",
    text: "テスト",
    timestampMs: 0,
    wordIds: [],
    detail: "detail",
    ...overrides,
  };
}

// --- detectAwkwardLineBreak ---

test("detectAwkwardLineBreak: 改行が無ければnull", () => {
  assert.equal(detectAwkwardLineBreak("今日はいい天気です"), null);
});

test("detectAwkwardLineBreak: カタカナ語の途中の改行を検出する", () => {
  assert.equal(detectAwkwardLineBreak("今日はチャー\nトをやります"), "チャート");
});

test("detectAwkwardLineBreak: 単語境界の改行はnull", () => {
  assert.equal(detectAwkwardLineBreak("今日は\nいい天気です"), null);
});

test("detectAwkwardLineBreak: 英数字連続の途中の改行も検出する", () => {
  assert.equal(detectAwkwardLineBreak("検索はgoo\ngleでします"), "google");
});

test("detectAwkwardLineBreak: 句読点直後の改行はnull(記号セグメントは無視)", () => {
  assert.equal(detectAwkwardLineBreak("そうです。\n次はこちら"), null);
});

test("detectAwkwardLineBreak: 複数改行のうち単語内部のものを検出する", () => {
  assert.equal(detectAwkwardLineBreak("今日は\n数学のチャー\nトです"), "チャート");
});

test("detectAwkwardLineBreak: 改行のみ・空文字で壊れない", () => {
  assert.equal(detectAwkwardLineBreak(""), null);
  assert.equal(detectAwkwardLineBreak("\n"), null);
  assert.equal(detectAwkwardLineBreak("あ\n"), null);
});

// --- W13-6: detectSceneBoundaryTruncation ---

test("W13-6 detectSceneBoundaryTruncation: 境界が単語の途中に落ちるケースを検出する", () => {
  // 「データベース」というカタカナ語の途中でシーンが切れている
  const result = detectSceneBoundaryTruncation("今日はデータ", "ベースの設計をやります");
  assert.deepEqual(result, { kind: "word_split", fragment: "データベース" });
});

test("W13-6 detectSceneBoundaryTruncation: 次シーン先頭1〜2文字の重複を検出する(2文字一致優先)", () => {
  // STTが境界で同じ音を二重に書き起こしたケース
  assert.deepEqual(detectSceneBoundaryTruncation("しっかり勉強しま", "しました後で復習します"), {
    kind: "duplicate_head",
    fragment: "しま",
  });
  assert.deepEqual(detectSceneBoundaryTruncation("これが結論で", "で次の話に移ります"), {
    kind: "duplicate_head",
    fragment: "で",
  });
});

test("W13-6 detectSceneBoundaryTruncation: 前シーンが句読点で閉じていれば検出しない", () => {
  assert.equal(detectSceneBoundaryTruncation("今日はデータ。", "ベースの設計をやります"), null);
  assert.equal(detectSceneBoundaryTruncation("そう思います。", "ますます頑張ります"), null);
});

test("W13-6 detectSceneBoundaryTruncation: 正常な文境界は検出しない", () => {
  assert.equal(detectSceneBoundaryTruncation("今日はいい天気です", "明日は雨が降りそうです"), null);
  // ひらがなのみの機能語連結(です+から)はノイズになるため検出しない
  assert.equal(detectSceneBoundaryTruncation("これが大事です", "から覚えてください"), null);
});

test("W13-6 detectSceneBoundaryTruncation: 空テキスト・改行入りでも壊れない", () => {
  assert.equal(detectSceneBoundaryTruncation("", "ベースの設計"), null);
  assert.equal(detectSceneBoundaryTruncation("今日はデータ", ""), null);
  // 表示テキストの改行は無視して判定する
  assert.deepEqual(detectSceneBoundaryTruncation("今日は\nデータ", "ベース\nの設計"), {
    kind: "word_split",
    fragment: "データベース",
  });
});

test("W13-6 buildReviewHotspots: 境界文字切れ疑いを次シーンのカードに載せる", () => {
  const sceneA = makeScene("scene_a", "今日は数学のデータ", 0);
  const sceneB = makeScene("scene_b", "ベースの話をします", 10000);
  const hotspots = buildReviewHotspots([sceneA, sceneB], new Map());
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0].scene.id, "scene_b");
  const item = hotspots[0].items[0];
  assert.equal(item.type, "boundary_truncation");
  assert.equal(item.label, "シーン境界の文字切れ疑い");
  assert.equal(item.severity, "medium");
  assert.equal(item.text, "データベース");
  assert.equal(item.timestampMs, 10000);
});

test("W13-6 buildReviewHotspots: 丸ごと削除済みシーンを挟んだ隣接判定になる", () => {
  const sceneA = makeScene("scene_a", "今日は数学のデータ", 0);
  const deleted = makeScene("scene_del", "ここは削除済みです", 5000);
  deleted.words = deleted.words.map((word) => ({ ...word, deleted: true }));
  const sceneB = makeScene("scene_b", "ベースの話をします", 10000);
  const hotspots = buildReviewHotspots([sceneA, deleted, sceneB], new Map());
  const boundaryCard = hotspots.find((hotspot) =>
    hotspot.items.some((item) => item.type === "boundary_truncation"),
  );
  assert.ok(boundaryCard, "削除済みシーンを飛ばして境界を判定する");
  assert.equal(boundaryCard!.scene.id, "scene_b");
});

// --- buildReviewHotspots ---

test("buildReviewHotspots: シーン順に1シーン1カードで集約する", () => {
  const sceneA = makeScene("scene_a", "白チャートから始めました", 0);
  const sceneB = makeScene("scene_b", "医学部を目指しています", 10000);
  const suspicions = new Map<string, SuspicionItem[]>([
    ["scene_b", [makeSuspicion({ id: "s-b1", wordIds: ["scene_b-w0"] })]],
    [
      "scene_a",
      [
        makeSuspicion({ id: "s-a1", wordIds: ["scene_a-w0", "scene_a-w1"] }),
        makeSuspicion({ id: "s-a2", type: "word_split", label: "カット境界の単語分断の疑い" }),
      ],
    ],
  ]);
  const hotspots = buildReviewHotspots([sceneA, sceneB], suspicions);
  assert.equal(hotspots.length, 2);
  assert.equal(hotspots[0].scene.id, "scene_a");
  assert.equal(hotspots[0].sceneOrdinal, 1);
  assert.equal(hotspots[0].items.length, 2);
  assert.deepEqual([...hotspots[0].flaggedWordIds].sort(), ["scene_a-w0", "scene_a-w1"]);
  assert.equal(hotspots[1].scene.id, "scene_b");
  assert.equal(hotspots[1].sceneOrdinal, 2);
});

test("buildReviewHotspots: sceneOrdinalは全シーン中の位置(除外シーンがあってもズレない)", () => {
  const tiny = makeScene("scene_tiny", "の");
  const target = makeScene("scene_target", "白チャートをやります", 5000);
  const suspicions = new Map<string, SuspicionItem[]>([
    ["scene_tiny", [makeSuspicion({ id: "s-t" })]],
    ["scene_target", [makeSuspicion({ id: "s-x" })]],
  ]);
  const hotspots = buildReviewHotspots([tiny, target], suspicions);
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0].sceneOrdinal, 2);
});

test("buildReviewHotspots: tinyシーン(正規化後2文字以下)は疑義があっても出さない", () => {
  const scenes = [
    makeScene("scene_1", "の"),
    makeScene("scene_2", "この"),
    makeScene("scene_3", "はい。"),
  ];
  const suspicions = new Map<string, SuspicionItem[]>(
    scenes.map((scene) => [scene.id, [makeSuspicion({ id: `s-${scene.id}` })]]),
  );
  assert.equal(buildReviewHotspots(scenes, suspicions).length, 0);
});

test("buildReviewHotspots: 3文字フィラー(あのー等)のシーンも出さない", () => {
  const scenes = [
    makeScene("scene_1", "あのー"),
    makeScene("scene_2", "えっと"),
    makeScene("scene_3", "うーん"),
    makeScene("scene_4", "なんか"),
  ];
  const suspicions = new Map<string, SuspicionItem[]>(
    scenes.map((scene) => [scene.id, [makeSuspicion({ id: `s-${scene.id}` })]]),
  );
  assert.equal(buildReviewHotspots(scenes, suspicions).length, 0);
});

test("buildReviewHotspots: ai_failure / filler / low_confidence はパネルに含めない", () => {
  const scene = makeScene("scene_1", "白チャートをやります");
  const suspicions = new Map<string, SuspicionItem[]>([
    [
      "scene_1",
      [
        makeSuspicion({ id: "s-fail", type: "ai_failure" }),
        makeSuspicion({ id: "s-filler", type: "filler" }),
        makeSuspicion({ id: "s-conf", type: "low_confidence" }),
      ],
    ],
  ]);
  assert.equal(buildReviewHotspots([scene], suspicions).length, 0);
});

test("buildReviewHotspots: 改行疑義しかないシーンもパネルに出す", () => {
  const scene = makeScene("scene_1", "数学のチャー\nトをやります");
  const hotspots = buildReviewHotspots([scene], new Map());
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0].items.length, 1);
  const item = hotspots[0].items[0];
  assert.equal(item.id, "line_break:scene_1");
  assert.equal(item.severity, "medium");
  assert.equal(item.label, "改行が単語の途中");
  assert.equal(item.detail, "「チャート」の途中で改行されています");
  assert.deepEqual(item.wordIds, []);
});

test("buildReviewHotspots: 疑義0件かつ改行正常のシーンは出さない", () => {
  const scene = makeScene("scene_1", "今日は\nいい天気です");
  assert.equal(buildReviewHotspots([scene], new Map()).length, 0);
});

test("buildReviewHotspots: tinyTextMaxCharsオプションで閾値を変えられる", () => {
  const scene = makeScene("scene_1", "白チャート");
  const suspicions = new Map<string, SuspicionItem[]>([["scene_1", [makeSuspicion()]]]);
  assert.equal(buildReviewHotspots([scene], suspicions, { tinyTextMaxChars: 5 }).length, 0);
  assert.equal(buildReviewHotspots([scene], suspicions, { tinyTextMaxChars: 2 }).length, 1);
});

// --- W14-2: 編集済みシーンの疑義除外と修正履歴の決定的昇格 ---

test("W14-2 buildReviewHotspots: 編集済みシーンの既存疑義はユーザー確認済みとして除外する", () => {
  const sceneA = makeScene("scene_a", "白チャートから始めました", 0);
  const sceneB = makeScene("scene_b", "医学部を目指しています", 10000);
  const suspicions = new Map<string, SuspicionItem[]>([
    ["scene_a", [makeSuspicion({ id: "s-a" })]],
    ["scene_b", [makeSuspicion({ id: "s-b" })]],
  ]);
  const hotspots = buildReviewHotspots([sceneA, sceneB], suspicions, {
    editedSceneIds: new Set(["scene_a"]),
  });
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0].scene.id, "scene_b");
});

test("W14-2 buildReviewHotspots: 編集済みシーンでも決定的検出(改行疑義)は編集後テキスト基準で残る", () => {
  const scene = makeScene("scene_1", "数学のチャー\nトをやります");
  const suspicions = new Map<string, SuspicionItem[]>([["scene_1", [makeSuspicion({ id: "s-old" })]]]);
  const hotspots = buildReviewHotspots([scene], suspicions, {
    editedSceneIds: new Set(["scene_1"]),
  });
  assert.equal(hotspots.length, 1);
  assert.deepEqual(
    hotspots[0].items.map((item) => item.id),
    ["line_break:scene_1"],
  );
});

test("W14-2 buildReviewHotspots: 修正履歴に頻出する誤表記が残っていれば決定的に要確認へ昇格する", () => {
  const scene = makeScene("scene_1", "平谷塾で勉強しています");
  const hotspots = buildReviewHotspots([scene], new Map(), {
    correctionHistoryPairs: [{ before: "平谷塾", after: "白谷塾", count: 3 }],
  });
  assert.equal(hotspots.length, 1);
  const item = hotspots[0].items[0];
  assert.equal(item.type, "correction_history");
  assert.equal(item.label, "過去に修正した表記");
  assert.equal(item.severity, "medium");
  assert.equal(item.text, "平谷塾");
  assert.equal(item.suggestion, "白谷塾");
  assert.ok(item.detail.includes("「平谷塾」→「白谷塾」"));
});

test("W14-2 buildReviewHotspots: 頻度が閾値未満・誤表記なしのシーンは昇格しない", () => {
  const pairs = [{ before: "平谷塾", after: "白谷塾", count: 1 }];
  const withWrong = makeScene("scene_1", "平谷塾で勉強しています");
  assert.equal(
    buildReviewHotspots([withWrong], new Map(), { correctionHistoryPairs: pairs }).length,
    0,
  );
  const clean = makeScene("scene_2", "白谷塾で勉強しています");
  assert.equal(
    buildReviewHotspots(
      [clean],
      new Map(),
      { correctionHistoryPairs: [{ before: "平谷塾", after: "白谷塾", count: 5 }] },
    ).length,
    0,
  );
});

test("W14-2 buildReviewHotspots: correctionHistoryPairs未指定なら従来と同じ結果(後方互換)", () => {
  const scene = makeScene("scene_1", "白チャートをやります");
  const suspicions = new Map<string, SuspicionItem[]>([["scene_1", [makeSuspicion()]]]);
  const legacy = buildReviewHotspots([scene], suspicions);
  const withOptions = buildReviewHotspots([scene], suspicions, {});
  assert.equal(legacy.length, withOptions.length);
  assert.deepEqual(
    legacy[0].items.map((item) => item.id),
    withOptions[0].items.map((item) => item.id),
  );
});

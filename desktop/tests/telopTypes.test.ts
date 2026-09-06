import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SEMANTIC_TYPE,
  DEFAULT_TYPE_MAPPING,
  SEMANTIC_TYPES,
  SEMANTIC_TYPE_INFO,
  isSemanticType,
  resolveAnimationForType,
  resolveStyleForType,
  sanitizeSemanticType,
  sanitizeTypeMapping,
  semanticTypeLabel,
} from "../src/lib/telopTypes.ts";
import {
  DIRECTED_STYLE_OPTIONS,
  deriveDirectedSlots,
  effectiveDirectedStyleId,
} from "../src/lib/directedTelop.ts";
import {
  initializeScenes,
  resetSceneIdCounterForTests,
  setSceneDirectedType,
  type SourceWord,
} from "../src/lib/scenes.ts";

// フェーズT2.5-4(シーン種類ベースのプリセット体系)のUI側テスト。

function words(...specs: Array<[string, string, number, number]>): SourceWord[] {
  return specs.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

// --- semantic type の基本 ---

test("SEMANTIC_TYPES: 10種で、全typeに日本語名・説明・既定マッピングがある", () => {
  assert.equal(SEMANTIC_TYPES.length, 10);
  const styleIds = new Set(DIRECTED_STYLE_OPTIONS.map((option) => option.id));
  for (const type of SEMANTIC_TYPES) {
    assert.ok(SEMANTIC_TYPE_INFO[type].label, `${type} にラベルがある`);
    assert.ok(SEMANTIC_TYPE_INFO[type].description, `${type} に説明がある`);
    // フェーズT3: 既定マッピングは { style, animation_in?, sfx? } エントリ
    assert.ok(styleIds.has(DEFAULT_TYPE_MAPPING[type].style), `${type} の既定プリセットが選択肢に存在する`);
  }
});

test("sanitizeSemanticType: 未知・欠落は default へ正規化する", () => {
  assert.equal(sanitizeSemanticType("harsh"), "harsh");
  assert.equal(sanitizeSemanticType("unknown"), DEFAULT_SEMANTIC_TYPE);
  assert.equal(sanitizeSemanticType(null), DEFAULT_SEMANTIC_TYPE);
  assert.equal(sanitizeSemanticType(undefined), DEFAULT_SEMANTIC_TYPE);
  assert.equal(sanitizeSemanticType(42), DEFAULT_SEMANTIC_TYPE);
});

test("isSemanticType / semanticTypeLabel: 型ガードと日本語ラベル", () => {
  assert.equal(isSemanticType("quote"), true);
  assert.equal(isSemanticType("fact_yellow"), false);
  assert.equal(isSemanticType(null), false);
  assert.equal(semanticTypeLabel("quote"), "名言");
  assert.equal(semanticTypeLabel("cta"), "CTA");
  assert.equal(semanticTypeLabel("unknown"), "説明", "未知typeはdefaultのラベル");
});

// --- マッピングの正規化と解決 ---

test("sanitizeTypeMapping: 欠落・不正値は既定マッピングで補完する(旧形式=文字列も読める)", () => {
  const mapping = sanitizeTypeMapping({ harsh: "box_red", quote: "", surprise: 42 });
  assert.deepEqual(mapping.harsh, { style: "box_red" }, "旧形式(文字列)は{style}エントリへ包む");
  assert.deepEqual(mapping.quote, DEFAULT_TYPE_MAPPING.quote, "空文字は既定へフォールバック");
  assert.deepEqual(mapping.surprise, DEFAULT_TYPE_MAPPING.surprise, "文字列以外は既定へフォールバック");
  assert.deepEqual(mapping.default, DEFAULT_TYPE_MAPPING.default);
  assert.equal(Object.keys(mapping).length, SEMANTIC_TYPES.length, "常に全typeのエントリを持つ");
});

test("sanitizeTypeMapping: 新形式エントリのanimation_in/sfxを保持し、不正フィールドは落とす", () => {
  const mapping = sanitizeTypeMapping({
    emphasis: { style: "box_red", animation_in: "stamp", sfx: "hyu" },
    quote: { animation_in: "fade" },
    reply: { sfx: "none" },
    punchline: { style: "", animation_in: 42, sfx: {} },
  });
  assert.deepEqual(mapping.emphasis, { style: "box_red", animation_in: "stamp", sfx: "hyu" });
  // styleを指定しないエントリは既定styleを維持したままアニメ/SFXだけ上書きする
  assert.deepEqual(mapping.quote, { style: DEFAULT_TYPE_MAPPING.quote.style, animation_in: "fade" });
  assert.deepEqual(mapping.reply, { style: DEFAULT_TYPE_MAPPING.reply.style, sfx: "none" });
  assert.deepEqual(mapping.punchline, DEFAULT_TYPE_MAPPING.punchline, "全フィールド不正は既定のまま");
});

test("sanitizeTypeMapping: null/undefined/非オブジェクトでも既定マッピングを返す", () => {
  assert.deepEqual(sanitizeTypeMapping(null), DEFAULT_TYPE_MAPPING);
  assert.deepEqual(sanitizeTypeMapping(undefined), DEFAULT_TYPE_MAPPING);
  assert.deepEqual(sanitizeTypeMapping("broken"), DEFAULT_TYPE_MAPPING);
});

test("resolveStyleForType: ユーザーマッピング優先・未指定は既定マッピング(新旧両形式)", () => {
  assert.equal(resolveStyleForType("harsh"), "serif_harsh");
  assert.equal(resolveStyleForType("harsh", { harsh: "box_red" }), "box_red", "旧形式(文字列)");
  assert.equal(resolveStyleForType("harsh", { harsh: { style: "box_red" } }), "box_red", "新形式(エントリ)");
  assert.equal(resolveStyleForType("unknown", { default: "neutral_white" }), "neutral_white");
  assert.equal(resolveStyleForType(null), DEFAULT_TYPE_MAPPING.default.style);
});

test("resolveAnimationForType: マッピングのanimation_inを解決する(未指定はnull=プリセット既定)", () => {
  assert.equal(resolveAnimationForType("emphasis", { emphasis: { style: "emotion_red", animation_in: "stamp" } }), "stamp");
  assert.equal(resolveAnimationForType("emphasis", { emphasis: "emotion_red" }), null, "旧形式はアニメ指定なし");
  assert.equal(resolveAnimationForType("emphasis"), null, "既定マッピングにアニメ指定は無い");
  assert.equal(
    resolveAnimationForType("unknown", { default: { style: "fact_yellow", animation_in: "fade" } }),
    "fade",
    "未知typeはdefault扱い",
  );
});

// --- 有効スタイルの優先順位(python effective_slot_style と同期) ---

test("effectiveDirectedStyleId: 個別上書き > typeマッピング > 既定 の順で解決する", () => {
  // 1. 個別上書きが最優先
  assert.equal(
    effectiveDirectedStyleId({ directedStyleId: "box_red", directedType: "quote" }, { quote: "serif_quote" }),
    "box_red",
  );
  // 2. type × マッピング
  assert.equal(
    effectiveDirectedStyleId({ directedStyleId: null, directedType: "quote" }, { quote: "neutral_white" }),
    "neutral_white",
  );
  // 3. マッピング未指定なら既定マッピング
  assert.equal(effectiveDirectedStyleId({ directedStyleId: null, directedType: "harsh" }), "serif_harsh");
  // 4. type無し(旧run)は既定スタイル
  assert.equal(effectiveDirectedStyleId({ directedStyleId: null, directedType: null }), "fact_yellow");
});

// --- ページ境界からのシーン初期化(type対応) ---

test("initializeScenes: typeIdありのシーンはdirectedTypeを持ち、非上書きのstyleIdは保持しない", () => {
  const scenes = initializeScenes({
    words: words(["w1", "それは言い訳です", 0, 1000], ["w2", "継続が全てです", 1000, 2000]),
    keepSegments: [{ startMs: 0, endMs: 2000 }],
    telopPageBoundaries: [
      // マッピング解決済みのstyle(非上書き)はスナップショットとして持たない
      { startMs: 0, endMs: 1000, text: "それは言い訳です", styleId: "serif_harsh", typeId: "harsh" },
      // 個別上書き(styleOverridden)はdirectedStyleIdとして保持する
      {
        startMs: 1000,
        endMs: 2000,
        text: "継続が全てです",
        styleId: "box_red",
        typeId: "quote",
        styleOverridden: true,
      },
    ],
  });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].directedType, "harsh");
  assert.equal(scenes[0].directedStyleId, undefined, "非上書きはマッピング解決に任せる");
  assert.equal(scenes[1].directedType, "quote");
  assert.equal(scenes[1].directedStyleId, "box_red", "個別上書きは保持する");
});

test("initializeScenes: T2旧run(type無し・styleのみ)はstyleスナップショットが正のまま", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 1000]),
    keepSegments: [{ startMs: 0, endMs: 1000 }],
    telopPageBoundaries: [{ startMs: 0, endMs: 1000, text: "こんにちは", styleId: "reply_cyan" }],
  });
  assert.equal(scenes[0].directedType, undefined);
  assert.equal(scenes[0].directedStyleId, "reply_cyan");
});

// --- typeバッジからの変更 ---

test("setSceneDirectedType: typeを変更すると個別上書きは解除されマッピング解決へ戻る", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 1000]),
    keepSegments: [{ startMs: 0, endMs: 1000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 1000, text: "こんにちは", styleId: "box_red", typeId: "reply", styleOverridden: true },
    ],
  });
  const updated = setSceneDirectedType(scenes, scenes[0].id, "quote");
  assert.equal(updated[0].directedType, "quote");
  assert.equal(updated[0].directedStyleId, null, "type変更で個別上書きは解除される");
  assert.equal(effectiveDirectedStyleId(updated[0]), "serif_quote");
});

// --- 適用ペイロード(type対応) ---

test("deriveDirectedSlots: typeありシーンはマッピング解決済みstyleとtypeIdを送る", () => {
  const scenes = initializeScenes({
    words: words(["w1", "それは言い訳です", 0, 1000]),
    keepSegments: [{ startMs: 0, endMs: 1000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 1000, text: "それは言い訳です", styleId: "serif_harsh", typeId: "harsh" },
    ],
  });
  const slots = deriveDirectedSlots(scenes, { harsh: "box_red" });
  assert.equal(slots[0].typeId, "harsh");
  assert.equal(slots[0].styleId, "box_red", "ユーザーマッピングで再解決した結果を送る");
  assert.equal(slots[0].styleOverridden, false);
});

test("deriveDirectedSlots: 個別上書きシーンはstyleOverridden=trueでマッピングより優先する", () => {
  const scenes = initializeScenes({
    words: words(["w1", "こんにちは", 0, 1000]),
    keepSegments: [{ startMs: 0, endMs: 1000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 1000, text: "こんにちは", styleId: "box_red", typeId: "reply", styleOverridden: true },
    ],
  });
  const slots = deriveDirectedSlots(scenes, { reply: "reply_cyan" });
  assert.equal(slots[0].styleId, "box_red");
  assert.equal(slots[0].styleOverridden, true);
  assert.equal(slots[0].typeId, "reply");
});

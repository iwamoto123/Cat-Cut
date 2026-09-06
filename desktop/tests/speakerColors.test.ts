import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SPEAKER_COLORS,
  resolveActiveSpeakerColors,
  sanitizeSpeakerColors,
  significantSpeakers,
  type ActiveSpeakerColors,
  type SpeakerWord,
} from "../src/lib/speakerColors.ts";
import { deriveDirectedSlots, effectiveDirectedStyleId } from "../src/lib/directedTelop.ts";
import { initializeScenes, resetSceneIdCounterForTests } from "../src/lib/scenes.ts";

// フェーズW1(話者別テロップ色)のUI側テスト。
// python側の正(shared/speakers.py / effective_slot_style)と同じ規則になることを担保する。

function word(startMs: number, endMs: number, speaker?: string): SpeakerWord {
  return speaker ? { startMs, endMs, speaker } : { startMs, endMs };
}

const ACTIVE: ActiveSpeakerColors = {
  applyTypes: new Set(["default", "reply"]),
  styles: { speaker_1: "fact_cyan", speaker_2: "fact_green" },
};

test.beforeEach(() => {
  resetSceneIdCounterForTests();
});

// --- sanitizeSpeakerColors ---

test("sanitizeSpeakerColors: 欠落・不正は既定(有効・default/reply・cyan/green)へ落ちる", () => {
  assert.deepEqual(sanitizeSpeakerColors(null), DEFAULT_SPEAKER_COLORS);
  assert.deepEqual(sanitizeSpeakerColors("x"), DEFAULT_SPEAKER_COLORS);
  assert.deepEqual(sanitizeSpeakerColors({}), DEFAULT_SPEAKER_COLORS);
});

test("sanitizeSpeakerColors: 有効なフィールドだけ上書きされる", () => {
  const result = sanitizeSpeakerColors({
    enabled: false,
    apply_types: ["default", "unknown_type"],
    styles: { speaker_1: "question_blue", "": "fact_cyan", speaker_2: "" },
  });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.apply_types, ["default"]);
  assert.deepEqual(result.styles, { speaker_1: "question_blue" });
});

// --- significantSpeakers / 発動ガード ---

test("significantSpeakers: シェア10%以上の話者だけ発話時間降順で返す", () => {
  const words = [word(0, 8000, "speaker_0"), word(8000, 10000, "speaker_1")];
  assert.deepEqual(significantSpeakers(words), ["speaker_0", "speaker_1"]);
  // 2人目のシェアが5%なら1人だけ
  const oneSided = [word(0, 9500, "speaker_0"), word(9500, 10000, "speaker_1")];
  assert.deepEqual(significantSpeakers(oneSided), ["speaker_0"]);
});

test("significantSpeakers: speaker無しの旧run wordsは空配列(後方互換)", () => {
  assert.deepEqual(significantSpeakers([word(0, 5000), word(5000, 9000)]), []);
  assert.deepEqual(significantSpeakers([]), []);
});

test("resolveActiveSpeakerColors: 有効+2話者で発動、1人喋り・無効設定・旧runでは発動しない", () => {
  const twoSpeakers = [word(0, 6000, "speaker_0"), word(6000, 10000, "speaker_1")];
  const active = resolveActiveSpeakerColors(DEFAULT_SPEAKER_COLORS, twoSpeakers);
  assert.ok(active);
  assert.equal(active.styles.speaker_1, "fact_cyan");
  assert.ok(active.applyTypes.has("default"));

  // 1人喋りガード
  const solo = [word(0, 9500, "speaker_0"), word(9500, 10000, "speaker_1")];
  assert.equal(resolveActiveSpeakerColors(DEFAULT_SPEAKER_COLORS, solo), null);
  // 設定OFF
  assert.equal(
    resolveActiveSpeakerColors({ ...DEFAULT_SPEAKER_COLORS, enabled: false }, twoSpeakers),
    null,
  );
  // 旧run(speaker無し)
  assert.equal(resolveActiveSpeakerColors(DEFAULT_SPEAKER_COLORS, [word(0, 10000)]), null);
  // 設定未取得
  assert.equal(resolveActiveSpeakerColors(null, twoSpeakers), null);
});

// --- effectiveDirectedStyleId の優先順位(python effective_slot_style と同期) ---

test("effectiveDirectedStyleId: 話者カラーは基本タイプ(default/reply)のみ適用される", () => {
  assert.equal(
    effectiveDirectedStyleId({ directedType: "default", speaker: "speaker_1" }, null, ACTIVE),
    "fact_cyan",
  );
  assert.equal(
    effectiveDirectedStyleId({ directedType: "reply", speaker: "speaker_2" }, null, ACTIVE),
    "fact_green",
  );
  // apply_types外(harsh)はtype→マッピングの色を維持する
  assert.equal(
    effectiveDirectedStyleId({ directedType: "harsh", speaker: "speaker_1" }, null, ACTIVE),
    "serif_harsh",
  );
});

test("effectiveDirectedStyleId: 個別上書きは話者カラーより優先される", () => {
  assert.equal(
    effectiveDirectedStyleId(
      { directedStyleId: "box_red", directedType: "default", speaker: "speaker_1" },
      null,
      ACTIVE,
    ),
    "box_red",
  );
});

test("effectiveDirectedStyleId: マッピング無し話者(speaker_0)・speakerColors=nullは従来解決のまま", () => {
  assert.equal(
    effectiveDirectedStyleId({ directedType: "default", speaker: "speaker_0" }, null, ACTIVE),
    "fact_yellow",
  );
  assert.equal(
    effectiveDirectedStyleId({ directedType: "default", speaker: "speaker_1" }, null, null),
    "fact_yellow",
  );
  assert.equal(
    effectiveDirectedStyleId({ directedType: "default", speaker: "speaker_1" }, null),
    "fact_yellow",
  );
});

// --- シーン初期化・スロット書き戻しへのspeaker伝搬 ---

test("initializeScenes: ページ境界のspeakerがシーンへ引き継がれる(旧runは未設定)", () => {
  const scenes = initializeScenes({
    words: [
      { id: "w1", text: "こんにちは", startMs: 0, endMs: 1000 },
      { id: "w2", text: "どうも", startMs: 1000, endMs: 2000 },
    ],
    keepSegments: [{ startMs: 0, endMs: 2000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 1000, styleId: "fact_yellow", typeId: "default", speaker: "speaker_1" },
      { startMs: 1000, endMs: 2000, styleId: "fact_yellow", typeId: "default" },
    ],
  });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].speaker, "speaker_1");
  assert.equal(scenes[1].speaker, undefined);
});

test("deriveDirectedSlots: スナップショットstyleIdも話者カラー込みで解決される", () => {
  const scenes = initializeScenes({
    words: [{ id: "w1", text: "こんにちは", startMs: 0, endMs: 1000 }],
    keepSegments: [{ startMs: 0, endMs: 1000 }],
    telopPageBoundaries: [
      { startMs: 0, endMs: 1000, styleId: "fact_yellow", typeId: "default", speaker: "speaker_1" },
    ],
  });
  const withColors = deriveDirectedSlots(scenes, null, ACTIVE);
  assert.equal(withColors[0].styleId, "fact_cyan");
  assert.equal(withColors[0].styleOverridden, false);
  // 発動しない場合は従来どおり
  const withoutColors = deriveDirectedSlots(scenes, null, null);
  assert.equal(withoutColors[0].styleId, "fact_yellow");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OP_ACCENT_COLOR,
  normalizeOpClipDisplay,
  normalizeOpClipRole,
  normalizeOpData,
  normalizeOpDecoration,
  normalizeOpHookKeywordColor,
  normalizeOpTextAnimation,
  opClipSlowZoomScale,
  opClipTelopTiming,
  opClipTransitionFrames,
  opDecorationHasEndTitle,
  opHookFontPx,
  opHookLineStartFrame,
  opHookLines,
  opHookSegments,
  opQuestionHookPhases,
  opSfxVolume,
  opTeaserClipFrames,
  opTeaserTitleFrame,
  opTitleCardPhases,
} from "../src/lib/opTimeline.ts";

// フェーズU8: timeline.op の正規化とOP内部タイミングの決定性を検証する。

test("normalizeOpData: opなし・不正patternはnull(後方互換)", () => {
  assert.equal(normalizeOpData(undefined), null);
  assert.equal(normalizeOpData(null), null);
  assert.equal(normalizeOpData({}), null);
  assert.equal(normalizeOpData({ pattern: "none", duration_ms: 4000 }), null);
  assert.equal(normalizeOpData({ pattern: "unknown", duration_ms: 4000 }), null);
  assert.equal(normalizeOpData({ pattern: "title_card", duration_ms: 0 }), null);
  assert.equal(normalizeOpData({ pattern: "title_card" }), null);
});

test("normalizeOpData: title_cardの最小構成が既定値で補完される", () => {
  const op = normalizeOpData({ pattern: "title_card", duration_ms: 4000 });
  assert.ok(op);
  assert.equal(op.pattern, "title_card");
  assert.equal(op.duration_ms, 4000);
  assert.equal(op.title, "");
  assert.equal(op.catch_copy, "");
  assert.equal(op.accent_color, DEFAULT_OP_ACCENT_COLOR);
  assert.equal(op.sfx_hit, null);
  assert.equal(op.sfx_transition, null);
  assert.deepEqual(op.highlight_cuts, []);
});

test("normalizeOpData: highlight_teaserは有効クリップ必須・不正クリップは捨てる", () => {
  assert.equal(normalizeOpData({ pattern: "highlight_teaser", duration_ms: 4000 }), null);
  assert.equal(
    normalizeOpData({
      pattern: "highlight_teaser",
      duration_ms: 4000,
      highlight_cuts: [{ file_path: "", start_ms: 0, end_ms: 1500 }],
    }),
    null,
  );
  const op = normalizeOpData({
    pattern: "highlight_teaser",
    duration_ms: 4600,
    sfx_hit: "don",
    highlight_cuts: [
      { file_path: "/tmp/seg_000.mp4", start_ms: 100, end_ms: 1700 },
      { file_path: "/tmp/seg_002.mp4", start_ms: 0, end_ms: 0 }, // end<=start は不正
      { file_path: "/tmp/seg_003.mp4", start_ms: 500, end_ms: 2000 },
    ],
  });
  assert.ok(op);
  assert.equal(op.highlight_cuts.length, 2);
  assert.equal(op.sfx_hit, "don");
});

test("normalizeOpData: フェーズV2 クリップのtext/styleを保持し、無ければ空文字(後方互換)", () => {
  const op = normalizeOpData({
    pattern: "highlight_teaser",
    duration_ms: 3500,
    highlight_cuts: [
      { file_path: "/tmp/seg_000.mp4", start_ms: 0, end_ms: 2000, text: "ここが神回", style: "special_purple" },
      // 旧composition(V2以前)のクリップにはtext/styleが無い=テロップなしで従来通り描画
      { file_path: "/tmp/seg_001.mp4", start_ms: 0, end_ms: 1500 },
    ],
  });
  assert.ok(op);
  assert.equal(op.highlight_cuts[0].text, "ここが神回");
  assert.equal(op.highlight_cuts[0].style, "special_purple");
  assert.equal(op.highlight_cuts[1].text, "");
  assert.equal(op.highlight_cuts[1].style, "");
});

test("opTitleCardPhases: タイトル0.4秒→キャッチ45%→終端0.5秒前フェード(30fps/4秒)", () => {
  const phases = opTitleCardPhases(120, 30);
  assert.equal(phases.titleFrame, 12); // 0.4s
  assert.equal(phases.catchFrame, 54); // 45%
  assert.equal(phases.fadeOutFrame, 105); // 4s - 0.5s
  assert.ok(phases.titleFrame < phases.catchFrame);
  assert.ok(phases.catchFrame <= phases.fadeOutFrame);
});

test("opTitleCardPhases: 極端に短い尺でもフレーム順序が破綻しない", () => {
  const phases = opTitleCardPhases(10, 30);
  assert.ok(phases.titleFrame >= 0);
  assert.ok(phases.titleFrame < phases.fadeOutFrame);
  assert.ok(phases.catchFrame <= phases.fadeOutFrame);
});

test("opQuestionHookPhases: 問いが先(0.3秒)・タイトルは55%地点(30fps/5秒)", () => {
  const phases = opQuestionHookPhases(150, 30);
  assert.equal(phases.catchFrame, 9); // 問いテキスト 0.3s
  assert.equal(phases.titleFrame, 83); // 55%
  assert.equal(phases.fadeOutFrame, 135);
  assert.ok(phases.catchFrame < phases.titleFrame);
});

test("opTeaserClipFrames: クリップが隙間なく直列に並ぶ(30fps)", () => {
  const clips = [
    { file_path: "/a.mp4", start_ms: 0, end_ms: 1500, text: "", style: "" },
    { file_path: "/b.mp4", start_ms: 200, end_ms: 2200, text: "", style: "" },
  ];
  const placed = opTeaserClipFrames(clips, 30);
  assert.equal(placed.length, 2);
  assert.equal(placed[0].from, 0);
  assert.equal(placed[0].durationInFrames, 45);
  assert.equal(placed[1].from, 45);
  assert.equal(placed[1].durationInFrames, 60);
});

test("opTeaserTitleFrame: タイトル被せは終端1.4秒前", () => {
  assert.equal(opTeaserTitleFrame(180, 30), 138);
  assert.equal(opTeaserTitleFrame(10, 30), 0); // 短すぎても負にならない
});

test("opClipTelopTiming: フェーズV2 白フラッシュ後(約0.08秒)に入り、クリップ終端まで表示", () => {
  const timing = opClipTelopTiming(60, 30);
  assert.equal(timing.startFrame, 2); // 30fps × 0.08s ≒ 2フレーム(先頭2フレームの白フラッシュ後)
  assert.equal(timing.endFrame, 60);
  // 極端に短いクリップでも start < end の順序が破綻しない
  const tiny = opClipTelopTiming(1, 30);
  assert.ok(tiny.startFrame >= 0);
  assert.ok(tiny.startFrame < tiny.endFrame);
});

test("opSfxVolume: キメ音は0.4へ持ち上げ・ミュート(0)は尊重", () => {
  assert.equal(opSfxVolume(0.25), 0.4);
  assert.equal(opSfxVolume(0.8), 0.8);
  assert.equal(opSfxVolume(1.5), 1);
  assert.equal(opSfxVolume(0), 0);
  assert.equal(opSfxVolume(-1), 0);
});

// --- フェーズV5: 装飾パターンとテロップ登場アニメ ---

test("normalizeOpData: フェーズV5 decoration/text_animationの保持と既定値(旧composition後方互換)", () => {
  const legacy = normalizeOpData({
    pattern: "highlight_teaser",
    duration_ms: 2000,
    highlight_cuts: [{ file_path: "/tmp/seg_000.mp4", start_ms: 0, end_ms: 2000 }],
  });
  assert.ok(legacy);
  // 旧composition(V5以前)は既定=flash_pop/slide_left(=現行の見た目のまま)
  assert.equal(legacy.decoration, "flash_pop");
  assert.equal(legacy.text_animation, "slide_left");

  const v5 = normalizeOpData({
    pattern: "highlight_teaser",
    duration_ms: 2000,
    decoration: "neon_frame",
    text_animation: "stamp",
    highlight_cuts: [{ file_path: "/tmp/seg_000.mp4", start_ms: 0, end_ms: 2000 }],
  });
  assert.ok(v5);
  assert.equal(v5.decoration, "neon_frame");
  assert.equal(v5.text_animation, "stamp");
});

test("normalizeOpDecoration / normalizeOpTextAnimation: 未知値は既定へ落とす", () => {
  assert.equal(normalizeOpDecoration("cinema_bars"), "cinema_bars");
  assert.equal(normalizeOpDecoration("sparkle"), "flash_pop");
  assert.equal(normalizeOpDecoration(undefined), "flash_pop");
  assert.equal(normalizeOpTextAnimation("slide_up"), "slide_up");
  assert.equal(normalizeOpTextAnimation("spin"), "slide_left");
  assert.equal(normalizeOpTextAnimation(null), "slide_left");
});

test("opClipTransitionFrames: 装飾ごとの転換演出フレーム数(30fps)", () => {
  // 白フラッシュ系は2フレーム固定(fps非依存の「一瞬の残像」)
  assert.equal(opClipTransitionFrames("flash_pop", 30), 2);
  assert.equal(opClipTransitionFrames("cinema_bars", 60), 2);
  // ワイプは約0.28秒、ズームインは約0.2秒
  assert.equal(opClipTransitionFrames("color_wipe", 30), 8);
  assert.equal(opClipTransitionFrames("neon_frame", 30), 6);
  // 低fpsでも最低2フレームを確保する
  assert.equal(opClipTransitionFrames("neon_frame", 5), 2);
});

test("opDecorationHasEndTitle: color_wipeのみ終端タイトル被せなし(バー常駐)", () => {
  assert.equal(opDecorationHasEndTitle("flash_pop"), true);
  assert.equal(opDecorationHasEndTitle("cinema_bars"), true);
  assert.equal(opDecorationHasEndTitle("neon_frame"), true);
  assert.equal(opDecorationHasEndTitle("color_wipe"), false);
});

// ---------------------------------------------------------------------------
// フェーズW: フックワード表示
// ---------------------------------------------------------------------------

test("normalizeOpData: フェーズW クリップのフックワード系メタを正規化する", () => {
  const op = normalizeOpData({
    pattern: "highlight_teaser",
    duration_ms: 12000,
    highlight_cuts: [
      {
        file_path: "/tmp/seg_000.mp4", start_ms: 0, end_ms: 3000,
        display: "hook", hook_text: "定時8時\n非人道的", keyword: "非人道的",
        keyword_color: "red", role: "hook_open",
      },
      // 旧composition(メタなし)は verbatim / yellow / punch の既定へ
      { file_path: "/tmp/seg_001.mp4", start_ms: 0, end_ms: 3000, text: "そのまま" },
      // hook_textなしで display=hook は矛盾→verbatimへ落とす
      { file_path: "/tmp/seg_002.mp4", start_ms: 0, end_ms: 3000, display: "hook" },
    ],
  });
  assert.ok(op);
  assert.equal(op.highlight_cuts[0].display, "hook");
  assert.equal(op.highlight_cuts[0].hook_text, "定時8時\n非人道的");
  assert.equal(op.highlight_cuts[0].keyword, "非人道的");
  assert.equal(op.highlight_cuts[0].keyword_color, "red");
  assert.equal(op.highlight_cuts[0].role, "hook_open");
  assert.equal(op.highlight_cuts[1].display, "verbatim");
  assert.equal(op.highlight_cuts[1].keyword_color, "yellow");
  assert.equal(op.highlight_cuts[1].role, "punch");
  assert.equal(op.highlight_cuts[2].display, "verbatim");
});

test("normalizeOpClipDisplay / Role / KeywordColor: 未知値の既定", () => {
  assert.equal(normalizeOpClipDisplay("hook", "一言"), "hook");
  assert.equal(normalizeOpClipDisplay("hook", ""), "verbatim"); // フック文言なしは不成立
  assert.equal(normalizeOpClipDisplay(undefined, "一言"), "hook"); // 文言があれば既定hook
  assert.equal(normalizeOpClipDisplay(undefined, ""), "verbatim");
  assert.equal(normalizeOpClipRole("cliffhanger"), "cliffhanger");
  assert.equal(normalizeOpClipRole("opener"), "punch");
  assert.equal(normalizeOpHookKeywordColor("red"), "red");
  assert.equal(normalizeOpHookKeywordColor("rainbow"), "yellow");
});

test("opHookLines: 最大2行・空行除去・CRLF正規化", () => {
  assert.deepEqual(opHookLines("定時8時\n非人道的"), ["定時8時", "非人道的"]);
  assert.deepEqual(opHookLines(" 一言 \r\n\r\n二言\n三言"), ["一言", "二言"]);
  assert.deepEqual(opHookLines(""), []);
});

test("opHookSegments: 核心語の最初の出現だけを色分け区間に分ける", () => {
  assert.deepEqual(opHookSegments("朝練は廃止?", "廃止"), [
    { text: "朝練は", keyword: false },
    { text: "廃止", keyword: true },
    { text: "?", keyword: false },
  ]);
  // 行全体が核心語
  assert.deepEqual(opHookSegments("非人道的", "非人道的"), [{ text: "非人道的", keyword: true }]);
  // 含まれない・空keywordは行全体が通常区間
  assert.deepEqual(opHookSegments("定時8時", "非人道的"), [{ text: "定時8時", keyword: false }]);
  assert.deepEqual(opHookSegments("定時8時", ""), [{ text: "定時8時", keyword: false }]);
});

test("opHookFontPx: 高さ16%上限・長い行は幅92%に収まるサイズへ縮小", () => {
  // 短い行(4文字)は高さ上限(1080*0.16=173)が効く
  assert.equal(opHookFontPx(["非人道的"], 1920, 1080), Math.round(1080 * 0.16));
  // 10文字の行は幅フィット(1920*0.92/10=177)と高さ上限の小さい方
  const tenChars = "あいうえおかきくけこ";
  assert.equal(opHookFontPx([tenChars], 1920, 1080), Math.round(1080 * 0.16));
  // 極端に長い行でも下限(高さ7%)を割らない
  const veryLong = tenChars.repeat(5);
  assert.equal(opHookFontPx([veryLong], 1920, 1080), Math.round(1080 * 0.07));
});

test("opClipSlowZoomScale: クリップ進行で1.0→1.06へ単調増加(決定的)", () => {
  assert.equal(opClipSlowZoomScale(0, 90), 1);
  assert.equal(opClipSlowZoomScale(45, 90), 1.03);
  assert.equal(opClipSlowZoomScale(90, 90), 1.06);
  // 範囲外・不正はクランプ
  assert.equal(opClipSlowZoomScale(180, 90), 1.06);
  assert.equal(opClipSlowZoomScale(10, 0), 1);
});

test("opHookLineStartFrame: 2行目は約0.3秒遅れてスタンプ(30fps)", () => {
  assert.equal(opHookLineStartFrame(0, 30), 2); // 白フラッシュ後(0.08秒)
  assert.equal(opHookLineStartFrame(1, 30), 11); // +0.3秒
});

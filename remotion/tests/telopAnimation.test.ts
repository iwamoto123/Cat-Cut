import test from "node:test";
import assert from "node:assert/strict";
import {
  ANIMATION_IN_TYPES,
  ANIMATION_OUT_TYPES,
  DEFAULT_ANIMATION_DURATION_FRAMES,
  resolveTelopAnimation,
  sanitizeAnimationIn,
  sanitizeAnimationOut,
} from "../src/lib/telopAnimation.ts";

/**
 * フェーズT3(テロップアニメーション)の解決ロジックのテスト。
 * 優先順位: telop個別 > プリセット既定 > timeline既定(旧名互換) > none。
 */

test("ANIMATION_IN_TYPES: 15種+noneが定義されている(W26でショート向けの強い5種を追加)", () => {
  assert.deepEqual(
    [...ANIMATION_IN_TYPES],
    [
      "pop_big",
      "slide_left",
      "slide_up",
      "zoom",
      "stamp",
      "fade",
      "blur_in",
      "typewriter",
      "wipe_up",
      "drop_settle",
      "slam",
      "bounce_left",
      "bounce_right",
      "rise_bounce",
      "drop_bounce",
      "none",
    ],
  );
  assert.deepEqual([...ANIMATION_OUT_TYPES], ["fade", "pop_out", "none"]);
});

test("sanitizeAnimationIn: W26のショート向け5種を受け付ける", () => {
  assert.equal(sanitizeAnimationIn("slam"), "slam");
  assert.equal(sanitizeAnimationIn("bounce_left"), "bounce_left");
  assert.equal(sanitizeAnimationIn("bounce_right"), "bounce_right");
  assert.equal(sanitizeAnimationIn("rise_bounce"), "rise_bounce");
  assert.equal(sanitizeAnimationIn("drop_bounce"), "drop_bounce");
});

test("sanitizeAnimationIn: 新体系IDはそのまま、旧名(popIn/fadeIn/stamp)は写像、未知はnull", () => {
  assert.equal(sanitizeAnimationIn("pop_big"), "pop_big");
  assert.equal(sanitizeAnimationIn("none"), "none");
  // W24 Phase B-1: 広告向け4種
  assert.equal(sanitizeAnimationIn("blur_in"), "blur_in");
  assert.equal(sanitizeAnimationIn("typewriter"), "typewriter");
  assert.equal(sanitizeAnimationIn("wipe_up"), "wipe_up");
  assert.equal(sanitizeAnimationIn("drop_settle"), "drop_settle");
  // 旧timeline設定の互換
  assert.equal(sanitizeAnimationIn("popIn"), "zoom");
  assert.equal(sanitizeAnimationIn("fadeIn"), "fade");
  assert.equal(sanitizeAnimationIn("stamp"), "stamp");
  // 未知・非文字列
  assert.equal(sanitizeAnimationIn("explode"), null);
  assert.equal(sanitizeAnimationIn(undefined), null);
  assert.equal(sanitizeAnimationIn(42), null);
});

test("sanitizeAnimationOut: 旧名(popOut/fadeOut)の互換写像", () => {
  assert.equal(sanitizeAnimationOut("pop_out"), "pop_out");
  assert.equal(sanitizeAnimationOut("popOut"), "pop_out");
  assert.equal(sanitizeAnimationOut("fadeOut"), "fade");
  assert.equal(sanitizeAnimationOut("mystery"), null);
});

test("resolveTelopAnimation: telop個別指定がプリセット既定・timeline既定より優先される", () => {
  const resolved = resolveTelopAnimation({
    telopAnimationIn: "slide_left",
    styleAnimationIn: "pop_big",
    timelineAnimationIn: "fade",
  });
  assert.equal(resolved.animationIn, "slide_left");
});

test("resolveTelopAnimation: telop個別が無ければプリセット既定 > timeline既定の順", () => {
  assert.equal(
    resolveTelopAnimation({ styleAnimationIn: "zoom", timelineAnimationIn: "fade" }).animationIn,
    "zoom",
  );
  assert.equal(resolveTelopAnimation({ timelineAnimationIn: "fade" }).animationIn, "fade");
});

test("resolveTelopAnimation: timeline既定の旧名(popIn等)も互換で解決される", () => {
  assert.equal(resolveTelopAnimation({ timelineAnimationIn: "popIn" }).animationIn, "zoom");
  assert.equal(resolveTelopAnimation({ timelineAnimationOut: "popOut" }).animationOut, "pop_out");
});

test("resolveTelopAnimation: どこにも指定が無ければnone", () => {
  const resolved = resolveTelopAnimation({});
  assert.equal(resolved.animationIn, "none");
  assert.equal(resolved.animationOut, "none");
});

test("resolveTelopAnimation: 不正な個別指定は無視して次の優先度へフォールバックする", () => {
  const resolved = resolveTelopAnimation({
    telopAnimationIn: "explode",
    styleAnimationIn: "stamp",
  });
  assert.equal(resolved.animationIn, "stamp");
});

test('resolveTelopAnimation: telop個別の"none"はプリセット既定を明示的に打ち消す', () => {
  const resolved = resolveTelopAnimation({
    telopAnimationIn: "none",
    styleAnimationIn: "pop_big",
  });
  assert.equal(resolved.animationIn, "none");
});

test("resolveTelopAnimation: durationFramesはプリセット指定を優先し、未指定は既定値", () => {
  assert.equal(resolveTelopAnimation({}).durationFrames, DEFAULT_ANIMATION_DURATION_FRAMES);
  assert.equal(resolveTelopAnimation({ styleDurationFrames: 20 }).durationFrames, 20);
  assert.equal(resolveTelopAnimation({ styleDurationFrames: 7.6 }).durationFrames, 8);
  assert.equal(
    resolveTelopAnimation({ styleDurationFrames: -3 }).durationFrames,
    DEFAULT_ANIMATION_DURATION_FRAMES,
    "不正値は既定値へ",
  );
});

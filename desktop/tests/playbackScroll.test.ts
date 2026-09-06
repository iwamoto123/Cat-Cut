// W14-1: OP行操作時のシーン一覧自動追従スクロール抑制フラグ(playbackScrollSuppressed)の遷移テスト。
// App.tsx の playOpClip / seekOpTimeline / handleOpClipsChange は "op-row"、
// playScene(通常) は "scene-row"、要確認パネル発は "hotspot-panel"、
// handleJumpToScene は "jump-to-scene" としてこの純関数を呼ぶ。
import test from "node:test";
import assert from "node:assert/strict";
import { playbackScrollSuppressedFor } from "../src/lib/playbackScroll.ts";

test("W14-1 playbackScrollSuppressedFor: OP行の操作(再生・シーク・トリム)で抑制フラグが立つ", () => {
  assert.equal(playbackScrollSuppressedFor("op-row"), true);
});

test("W14-1 playbackScrollSuppressedFor: 通常のシーン行再生で従来どおり追従へ復帰する", () => {
  assert.equal(playbackScrollSuppressedFor("scene-row"), false);
});

test("W14-1 playbackScrollSuppressedFor: 要確認パネル発の再生はW5-7どおり抑制のまま", () => {
  assert.equal(playbackScrollSuppressedFor("hotspot-panel"), true);
});

test("W14-1 playbackScrollSuppressedFor: 明示的なシーンジャンプで抑制を解除する(jumpFlashを効かせる)", () => {
  assert.equal(playbackScrollSuppressedFor("jump-to-scene"), false);
});

test("W14-1 playbackScrollSuppressedFor: OP操作→通常再生の順で抑制→解除と遷移する", () => {
  // OP再生ボタン → 抑制ON
  let suppressed = playbackScrollSuppressedFor("op-row");
  assert.equal(suppressed, true);
  // OP波形クリックシーク・幅変更ドラッグ中もONのまま
  suppressed = playbackScrollSuppressedFor("op-row");
  assert.equal(suppressed, true);
  // 通常のシーン行再生でOFFへ復帰
  suppressed = playbackScrollSuppressedFor("scene-row");
  assert.equal(suppressed, false);
});

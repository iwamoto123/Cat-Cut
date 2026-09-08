import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveKeepSegments,
  findSceneIndexAtEditMs,
  findSceneIndexAtMs,
  initializeScenes,
  isSceneFullyDeleted,
  setChipsDeleted,
  splitSceneAtMs,
} from "../src/lib/scenes.ts";
import { resolveKeepPlaybackAction } from "../src/lib/previewPlayback.ts";
import { resolveGroupDeleteLeftTarget, resolveGroupDeleteRightTarget, resolveGroupSplitTarget } from "../src/lib/playhead.ts";
import { sourceMsToTimelineEditMs, sourceMsToTimelineMs } from "../src/lib/previewTimeline.ts";
import { buildPreviewPlaylist, clampTimelineMsToPlaylist, playlistPositionForTimelineMs } from "../src/lib/previewPlaylist.ts";

const keep = [{ startMs: 1000, endMs: 3000 }, { startMs: 5000, endMs: 6000 }];
const words = [
  { id: "w1", text: "前半の言葉", startMs: 1100, endMs: 2700 },
  { id: "w2", text: "最後の言葉", startMs: 5100, endMs: 5700 },
];

test("停止中の編集シークは、切れ目直前100ms・OUT点・除去区間でも跳ばない", () => {
  for (const ms of [2900, 2950, 2999, 3000, 3500, 5999, 6000, 6100]) {
    assert.deepEqual(resolveKeepPlaybackAction(keep, ms, false), { seekMs: null, stop: false }, `${ms}ms`);
  }
});

test("再生中のカットは末尾100msを欠かさず、実際の切れ目で次keepへ進む", () => {
  for (const ms of [2900, 2950, 2999.99]) {
    assert.deepEqual(resolveKeepPlaybackAction(keep, ms, true), { seekMs: null, stop: false });
  }
  assert.deepEqual(resolveKeepPlaybackAction(keep, 3000, true), { seekMs: 5000, stop: false });
  assert.deepEqual(resolveKeepPlaybackAction(keep, 3016.7, true), { seekMs: 5000, stop: false });
  assert.deepEqual(resolveKeepPlaybackAction(keep, 5000, true), { seekMs: null, stop: false });
});

test("最終keep終端で停止し、フレーム超過した元動画の削除済み末尾はOUT点へ戻す", () => {
  assert.deepEqual(resolveKeepPlaybackAction(keep, 5999, true), { seekMs: null, stop: false });
  assert.deepEqual(resolveKeepPlaybackAction(keep, 6000, true), { seekMs: null, stop: true });
  assert.deepEqual(resolveKeepPlaybackAction(keep, 6033.333, true), { seekMs: 6000, stop: true });
});

test("短いkeepも全尺が再生対象で、隣接した切れ目はそのまま次区間へ続く", () => {
  const short = [{ startMs: 10, endMs: 40 }, { startMs: 40, endMs: 60 }];
  for (const ms of [10, 30, 39, 40, 59]) {
    assert.deepEqual(resolveKeepPlaybackAction(short, ms, true), { seekMs: null, stop: false });
  }
  assert.deepEqual(resolveKeepPlaybackAction(short, 0, true), { seekMs: 10, stop: false });
  assert.deepEqual(resolveKeepPlaybackAction(short, 60, true), { seekMs: null, stop: true });
});

test("停止カーソルだけ最終シーンのOUT点を解決し、字幕再生用の半開区間は維持する", () => {
  const scenes = initializeScenes({ words, keepSegments: keep });
  assert.equal(findSceneIndexAtMs(scenes, 6000), -1);
  assert.equal(findSceneIndexAtEditMs(scenes, 6000), 1);
  assert.equal(findSceneIndexAtEditMs(scenes, 6000.0000001), 1);
  for (const ms of [3000, 4000, 6001, NaN]) assert.equal(findSceneIndexAtEditMs(scenes, ms), -1);
});

test("隣接シーン境界は次を優先し、末尾シーン削除後は残った最後のOUT点を解決する", () => {
  const scenes = initializeScenes({ words, keepSegments: [{ startMs: 1000, endMs: 6000 }],
    telopPageBoundaries: [{ startMs: 1000, endMs: 3000 }, { startMs: 3000, endMs: 6000 }],
  });
  assert.equal(findSceneIndexAtEditMs(scenes, 3000), 1);
  const deleted = setChipsDeleted(scenes, scenes[1].id, scenes[1].words.map((word) => word.id), true);
  assert.equal(findSceneIndexAtEditMs(deleted, 3000), 0);
  assert.equal(findSceneIndexAtEditMs(deleted, 6000), -1);
});

test("シーン検品の末尾Deleteは最後のチップを解決し、末尾で分割や右削除はしない", () => {
  const scenes = initializeScenes({ words, keepSegments: keep });
  const target = resolveGroupDeleteLeftTarget(scenes, 6000);
  assert.equal(target?.sceneId, scenes[1].id);
  assert.ok(target?.wordIds.includes("w2"));
  assert.equal(resolveGroupDeleteRightTarget(scenes, 6000), null);
  assert.equal(resolveGroupSplitTarget(scenes, 6000), null);
});

test("wordのない保存済み末尾keepも、削除・分割できる無音シーンとして初期化する", () => {
  for (const telopPageBoundaries of [undefined, [{ startMs: 1000, endMs: 3000 }]]) {
    const scenes = initializeScenes({ words: words.slice(0, 1), keepSegments: keep, telopPageBoundaries });
    assert.deepEqual(deriveKeepSegments(scenes), keep);
    const tail = scenes.at(-1)!;
    assert.equal(tail.telopText, "");
    assert.equal(tail.words[0].silence, true);
    const split = splitSceneAtMs(scenes, tail.id, 5900);
    assert.equal(split.length, scenes.length + 1);
    assert.deepEqual(deriveKeepSegments(split), keep);
    const deleted = setChipsDeleted(scenes, tail.id, tail.words.map((word) => word.id), true);
    assert.equal(isSceneFullyDeleted(deleted.at(-1)!), true);
    assert.deepEqual(deriveKeepSegments(deleted), keep.slice(0, 1));
  }
});

test("最後のテロップページに発話がなくてもkeep末尾を失わない", () => {
  const source = [{ startMs: 1000, endMs: 4000 }];
  const scenes = initializeScenes({ words: words.slice(0, 1), keepSegments: source,
    telopPageBoundaries: [{ startMs: 1000, endMs: 3000 }, { startMs: 3000, endMs: 4000 }],
  });
  assert.equal(scenes.length, 2);
  assert.equal(scenes[1].words[0].silence, true);
  assert.deepEqual(deriveKeepSegments(scenes), source);
  assert.equal(findSceneIndexAtEditMs(scenes, 4000), 1);
});

test("全編無音でも保存済みkeepの尺を保ち、無効なゼロ幅範囲は作らない", () => {
  const scenes = initializeScenes({ words: [], keepSegments: [...keep, { startMs: 7000, endMs: 7000 }] });
  assert.deepEqual(deriveKeepSegments(scenes), keep);
  assert.ok(scenes.every((scene) => scene.words.length === 1 && scene.words[0].silence));
});

test("停止したOUT点の時計は速度・OPオフセットを含む正しいtimeline末尾を示す", () => {
  const ranges = [
    { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 2000, timelineEndMs: 3000, speed: 2 },
    { sourceStartMs: 5000, sourceEndMs: 6000, timelineStartMs: 3000, timelineEndMs: 4000 },
  ];
  assert.equal(sourceMsToTimelineMs(ranges, 6000), null);
  assert.equal(sourceMsToTimelineEditMs(ranges, 6000), 4000);
  assert.equal(sourceMsToTimelineEditMs(ranges, 3000), 3000);
  assert.equal(sourceMsToTimelineEditMs(ranges, 2000), 2500);
  assert.equal(sourceMsToTimelineEditMs(ranges, 4000), null);
});

test("映像の精密分割は最後の一語の途中でも尺を保ち、発話テキストを複製しない", () => {
  const scenes = initializeScenes({
    words: [{ id: "long", text: "ありがとうございます", startMs: 1000, endMs: 4000 }],
    keepSegments: [{ startMs: 1000, endMs: 4000 }],
  });
  for (const ms of [1200, 3800]) {
    assert.equal(splitSceneAtMs(scenes, scenes[0].id, ms), scenes, "既存の語単位経路は互換維持");
    const split = splitSceneAtMs(scenes, scenes[0].id, ms, { allowEmptySpeechSide: true });
    assert.equal(split.length, 2);
    assert.equal(split[0].sourceEndMs, ms);
    assert.equal(split[1].sourceStartMs, ms);
    assert.deepEqual(deriveKeepSegments(split), [{ startMs: 1000, endMs: 4000 }]);
    assert.equal(split.flatMap((scene) => scene.words).filter((word) => word.id === "long").length, 1);
    assert.equal(split.map((scene) => scene.telopText).join(""), scenes[0].telopText);
    assert.ok(split.every((scene) => scene.words.length > 0));
  }
  for (const ms of [1000, 4000, NaN]) {
    assert.equal(splitSceneAtMs(scenes, scenes[0].id, ms, { allowEmptySpeechSide: true }), scenes);
  }
});

test("編集シークは実際の最終OUT点へ届き、通常の再生用クランプと隣接境界は変えない", () => {
  const playlist = buildPreviewPlaylist([
    { sourceStartMs: 1000, sourceEndMs: 3000, timelineStartMs: 0, timelineEndMs: 1000, speed: 2 },
    { sourceStartMs: 5000, sourceEndMs: 6000, timelineStartMs: 1000, timelineEndMs: 2000 },
  ], null);
  assert.equal(playlistPositionForTimelineMs(playlist, 2000), null);
  assert.deepEqual(clampTimelineMsToPlaylist(playlist, 2000), { index: 1, offsetMs: 999 });
  assert.deepEqual(clampTimelineMsToPlaylist(playlist, 2000, { allowFinalEnd: true }), { index: 1, offsetMs: 1000 });
  assert.deepEqual(clampTimelineMsToPlaylist(playlist, 99999, { allowFinalEnd: true }), { index: 1, offsetMs: 1000 });
  assert.deepEqual(clampTimelineMsToPlaylist(playlist, 1000, { allowFinalEnd: true }), { index: 1, offsetMs: 0 });
});

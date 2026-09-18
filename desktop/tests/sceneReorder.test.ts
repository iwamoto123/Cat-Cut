import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { reorderScene, deriveKeepSegments, deriveTelopOverrides, initializeScenes, mergeSceneWithNext, type Scene } from '../src/lib/scenes.ts';
import { compactRangesToKeepSegments } from '../src/lib/previewPlaylist.ts';
import { resolveOrderedKeepPlaybackAction } from '../src/lib/previewPlayback.ts';
import { createProjectEditor } from '../src/lib/projectEditor.ts';
const scenes: Scene[] = [0, 1, 2].map(i => ({ id: String(i), sourceStartMs: i * 1000, sourceEndMs: (i + 1) * 1000,
  sourceKeepRanges: [{startMs: i * 1000 + 100, endMs: (i + 1) * 1000 - 100}],
  words: [], telopText: `編集${i}`, telopEdited: true, cutMarks: [], speed: i === 1 ? 2 : 1 }));
test('insert preserves object identity, cuts, speed and captions; no-op stays out of history', () => {
  const moved = reorderScene(scenes, '2', '0');
  assert.deepEqual(moved.map(s=>s.id), ['2','0','1']);
  assert.equal(moved[0], scenes[2]);
  assert.equal(reorderScene(moved, '2', '0'), moved);
  assert.equal(reorderScene(moved, 'x', null), moved);
  assert.deepEqual(deriveKeepSegments(moved), [{startMs:2100,endMs:2900}, {startMs:100,endMs:900}, {startMs:1100,endMs:1900,speed:2}]);
  assert.deepEqual(deriveTelopOverrides(moved), ['編集2','編集0','編集1']);
  assert.deepEqual(reorderScene(moved, '2', null), scenes);
});
test('timeline insertion retains OP offset, removed gaps and source metadata', () => {
  const keeps=deriveKeepSegments(reorderScene(scenes,'2','0'));
  const ranges=compactRangesToKeepSegments([{sourceStartMs:0,sourceEndMs:3000,timelineStartMs:4000,timelineEndMs:7000,telopY:.8}],keeps);
  assert.deepEqual(ranges.map(r=>[r.sourceStartMs,r.timelineStartMs,r.timelineEndMs]),[[2100,4000,4800],[100,4800,5600],[1100,5600,6000]]);
  assert.ok(ranges.every(r=>r.telopY===.8));
});
test('ordered playback crosses backwards and forwards boundaries without entering source neighbors', () => {
  const keeps=deriveKeepSegments(reorderScene(scenes,'2','0'));
  assert.deepEqual(resolveOrderedKeepPlaybackAction(keeps,2200,true,-1),{seekMs:null,stop:false,activeIndex:0});
  assert.deepEqual(resolveOrderedKeepPlaybackAction(keeps,2900,true,0),{seekMs:100,stop:false,activeIndex:1});
  assert.deepEqual(resolveOrderedKeepPlaybackAction(keeps,950,true,1),{seekMs:1100,stop:false,activeIndex:2});
  assert.equal(resolveOrderedKeepPlaybackAction(keeps,1900,true,2).stop,true);
  assert.equal(resolveOrderedKeepPlaybackAction(keeps,2900,false,0).seekMs,null);
});
test('initialization keeps exported sequence on reopening without a draft', () => {
  const order=initializeScenes({words:[],keepSegments:deriveKeepSegments(reorderScene(scenes,'2','0'))});
  assert.deepEqual(order.map(s=>s.sourceStartMs),[2100,100,1100]);
});
test('unsafe reverse merge cannot erase or absorb another reordered scene', () => {
  const order=reorderScene(scenes,'2','0');
  assert.equal(mergeSceneWithNext(order,'2'),order);
  const interleaved=reorderScene(scenes,'1',null);
  assert.equal(mergeSceneWithNext(interleaved,'0'),interleaved);
});
test('export normalization retains edited sequence and calculates removal in source order', () => {
  const source=fs.readFileSync(new URL('../main/index.cjs',import.meta.url),'utf8');
  const start=source.indexOf('function normalizeSegmentsForProposal(');
  const end=source.indexOf('\nfunction ',source.indexOf('function buildRemoveRangesFromKeepSegments(',start)+10);
  const context=vm.createContext({}); vm.runInContext(source.slice(start,end),context);
  const normalized=context.normalizeSegmentsForProposal(deriveKeepSegments(reorderScene(scenes,'2','0')),3000);
  assert.deepEqual(Array.from(normalized,(r:any)=>r.start_ms),[2100,100,1100]);
  const removed=context.buildRemoveRangesFromKeepSegments(normalized,3000);
  assert.deepEqual(Array.from(removed,(r:any)=>[r.start_ms,r.end_ms]),[[0,100],[900,1100],[1900,2100],[2900,3000]]);
});
test('reorder is one undo step and leaves image/BGM tracks unchanged', () => {
  const editor=createProjectEditor();
  editor.hydrate('fixture',{scenes,images:null,bgm:null});
  editor.setScenes(current=>reorderScene(current,'2','0'));
  assert.equal(editor.getSnapshot().document.scenes[0].id,'2');
  editor.undo(); assert.equal(editor.getSnapshot().document.scenes,scenes);
  editor.redo(); assert.equal(editor.getSnapshot().document.scenes[0].id,'2');
});

import { applyEdgeTrim } from '../src/lib/edgeTrim.ts';
test('trim after reorder uses source neighbors, not previous timeline clip', () => {
  const order=reorderScene(scenes,'2','0');
  const end=applyEdgeTrim(order,0,'end',2800,{snapMs:1,chipSnapToleranceMs:0,sourceDurationMs:3000});
  assert.equal(end.scenes[0].sourceEndMs,2800);
  const start=applyEdgeTrim(order,1,'start',200,{snapMs:1,chipSnapToleranceMs:0,sourceDurationMs:3000});
  assert.equal(start.scenes[1].sourceStartMs,200);
  assert.equal(start.scenes[0],order[0]);
});

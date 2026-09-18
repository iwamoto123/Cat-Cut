import test from 'node:test';
import assert from 'node:assert/strict';
import { revealSceneRow } from '../src/lib/sceneScroll.ts';
function fixture(top:number,height=100) {
  const calls:unknown[]=[];
  const pane={clientTop:1,clientHeight:400,scrollTop:500,style:{paddingBottom:''},getBoundingClientRect:()=>({top:50}),scrollTo:(value:unknown)=>calls.push(value)};
  const row={closest:()=>pane,getBoundingClientRect:()=>({top,bottom:top+height,height})};
  return {calls,pane,row:row as unknown as HTMLElement};
}
test('visible playback row remains still; partially hidden row moves to top',()=>{
  const visible=fixture(100);revealSceneRow(visible.row,true);assert.equal(visible.calls.length,0);
  const hidden=fixture(400);revealSceneRow(hidden.row,true);assert.deepEqual(hidden.calls,[{top:849,behavior:'instant'}]);
});
test('explicit pause/navigation aligns visible row and reserves room for last row',()=>{
  const f=fixture(100);revealSceneRow(f.row);assert.deepEqual(f.calls,[{top:549,behavior:'instant'}]);assert.equal(f.pane.style.paddingBottom,'316px');
});
test('oversized row with visible heading does not keep scrolling',()=>{
 const f=fixture(60,600);revealSceneRow(f.row,true);assert.equal(f.calls.length,0);
});

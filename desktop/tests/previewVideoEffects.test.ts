import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { resolvePreviewVideoEffects } from "../src/lib/previewVideoEffects.ts";
import { initializeScenes, setSceneVideoEffectOverride } from "../src/lib/scenes.ts";
const ranges = [{ sourceStartMs: 0, sourceEndMs: 2000, timelineStartMs: 1000, timelineEndMs: 3000 }];
const scenes = () => initializeScenes({ words: [{id:"w",text:"確認",startMs:0,endMs:2000}], keepSegments:[{startMs:0,endMs:2000}] });
const raw = [{id:"auto",type:"dim",start_ms:1000,end_ms:3000}];
test("暗転→なし→Undo/自動を停止中のプレビューへ即時反映", () => {
 const original=scenes();const off=setSceneVideoEffectOverride(original,original[0].id,"none");
 assert.equal(resolvePreviewVideoEffects(raw,ranges,ranges,original)[0].type,"dim");
 assert.deepEqual(resolvePreviewVideoEffects(raw,ranges,ranges,off),[]);
 assert.equal(resolvePreviewVideoEffects(raw,ranges,ranges,setSceneVideoEffectOverride(off,off[0].id,null))[0].type,"dim");
});
test("全演出の手動指定と、OP・カット・速度変更の時間軸", () => {
 const original=scenes();const edited=[{sourceStartMs:1000,sourceEndMs:2000,timelineStartMs:5000,timelineEndMs:5500}];
 for (const type of ['dim','zoom','pinch','face_zoom','slow_push'] as const) {
  const effects=resolvePreviewVideoEffects(raw,ranges,edited,setSceneVideoEffectOverride(original,original[0].id,type));
  assert.equal(effects.length,1);assert.equal(effects[0].type,type);assert.equal(effects[0].start_ms,5000);assert.equal(effects[0].end_ms,5500);
 }
});
test("書き出し保存経路が全演出・なし・自動解除・空テロップを保持", () => {
 const source=fs.readFileSync(new URL('../main/index.cjs',import.meta.url),'utf8');
 const start=source.indexOf('function applyDirectedSlotEditsToDirectives(');const end=source.indexOf('\n/**',start);
 let saved:any;
 const ctx=vm.createContext({path,fs:{existsSync:()=>true},readJson:()=>({slots:[]}),writeJson:(_p:any,data:any)=>{saved=data;},TELOP_SEMANTIC_TYPES:[],TELOP_ANIMATION_IN_TYPES:[],normalizeTelopPosition:()=>null});
 vm.runInContext(source.slice(start,end),ctx);
 for(const text of ['確認','']) for(const type of ['none','pinch','zoom','dim','face_zoom','slow_push',null]) {
  ctx.applyDirectedSlotEditsToDirectives('/run',[{startMs:0,endMs:2000,text,videoEffectOverride:type}]);
  assert.equal(saved.slots[0].video_effect,type??undefined);
 }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { createExportDiagnostics } = createRequire(import.meta.url)("../main/exportDiagnostics.cjs");
for (const [type,status] of [["job:error","failed"],["job:done","completed"],["job:cancelled","cancelled"]]) {
 test(`export diagnostic persists ${status} without settings secrets`,()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"catcut-diagnostic-"));
  try {
   const d=createExportDiagnostics(root,{renderConcurrency:4,apiKey:"PRIVATE_KEY",learningSnapshot:{text:"PRIVATE_TEXT"}});
   d.record({type:"step:start",stepId:"render"});
   d.record({type,error:"npm terminated by signal SIGKILL"});
   const raw=fs.readFileSync(path.join(root,"export-diagnostic.json"),"utf8"), data=JSON.parse(raw);
   assert.equal(data.status,status); assert.equal(data.step,"render");
   assert.equal(data.settings.renderConcurrency,4); assert.ok(data.totalMemoryBytes>0);
   assert.equal(raw.includes("PRIVATE"),false);
   if(type==="job:error")assert.match(data.error,/SIGKILL/);
   assert.equal(fs.existsSync(path.join(root,"export-diagnostic.json.tmp")),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
 });
}
test("unwritable diagnostic does not abort export",()=>{
 const d=createExportDiagnostics("/nonexistent/catcut-diagnostic-test");
 assert.doesNotThrow(()=>d.record({type:"job:error",error:"render failed"}));
});

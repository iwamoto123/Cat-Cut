import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reduceExportStatus } = require('../main/backgroundExport.cjs');
const source = fs.readFileSync(new URL('../main/index.cjs', import.meta.url), 'utf8');
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function harness() {
  const handlers = new Map<string, Function>();
  const events: any[] = [];
  const context = vm.createContext({
    console, process, spawn, setTimeout, AsyncLocalStorage, reduceExportStatus,
    backgroundExport: null, backgroundExportStatus: null, activeJob: null,
    jobContext: new AsyncLocalStorage(),
    ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    resolveRunDir: (dir: string) => dir,
    createExportDiagnostics: () => ({ record() {} }),
    appendRunLog() {}, lowerChildPriority() {}, shellQuote: String,
    commandFailureMessage: () => 'process failed',
    mainWindow: { isDestroyed: () => false, webContents: { send: (_name: string, event: any) => events.push(event) } },
  });
  vm.runInContext('const currentJob = () => jobContext.getStore() || activeJob;', context);
  vm.runInContext(section('function sendJobEvent(', '/** W19-C5:'), context);
  vm.runInContext(section('function spawnCommand(', '\nfunction commandFailureMessage'), context);
  vm.runInContext(section('function assertRunEditable(', '\nlet previewServer'), context);
  vm.runInContext(`
    function handleProcessOutput(text) { sendJobEvent({type:'log', message:text}); }
    async function applyTelopAndExport(options) {
      sendJobEvent({type:'export:start',runDir:options.runDir});
      await spawnCommand({command:process.execPath,args:['-e',options.testScript || 'setTimeout(()=>console.log("rendered"), 50)'],stepId:'render'});
      sendJobEvent({type:'job:done',outputs:{finalVideo:options.runDir+'/final.mp4'}});
    }
  `, context);
  vm.runInContext(section('ipcMain.handle("export:status"', '\napp.whenReady()'), context);
  return { handlers, events, context };
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out');
}

test('background export returns immediately, protects only its run, and tags completion', async () => {
  const { handlers, events, context } = harness();
  const result = await handlers.get('export:start')!(null, {runDir:'/A'});
  assert.equal(result.ok, true);
  assert.equal(context.backgroundExportStatus.status, 'running');
  assert.throws(() => context.assertRunEditable('/A'), /書き出し中/);
  assert.doesNotThrow(() => context.assertRunEditable('/B'));
  assert.equal((await handlers.get('export:start')!(null, {runDir:'/B'})).ok, false);
  await until(() => context.backgroundExport === null);
  assert.equal(context.backgroundExportStatus.status, 'done');
  assert.equal(context.backgroundExportStatus.finalVideo, '/A/final.mp4');
  assert.ok(events.every(event => event.backgroundExport && event.exportRunDir === '/A'));
  assert.doesNotThrow(() => context.assertRunEditable('/A'));
});

test('cancelling export leaves a concurrent foreground child running and keeps events separate', async () => {
  const { handlers, events, context } = harness();
  await handlers.get('export:start')!(null, {runDir:'/A', testScript:'setTimeout(()=>{},10000)'});
  context.activeJob = {runDir:'/B',cancelled:false,child:null};
  const foreground = vm.runInContext(`spawnCommand({command:process.execPath,args:['-e','setTimeout(()=>console.log("editing B"),100)'],stepId:'analysis'})`,context);
  handlers.get('export:cancel')!();
  await foreground;
  await until(() => context.backgroundExport === null);
  assert.equal(context.activeJob.cancelled, false);
  assert.equal(context.backgroundExportStatus.status, 'cancelled');
  assert.ok(events.some(e => e.type === 'log' && e.message.includes('editing B') && !e.backgroundExport));
  assert.ok(events.some(e => e.type === 'job:cancelled' && e.backgroundExport));
});

test('export failure remains in the status endpoint and releases the run', async () => {
  const { handlers, context } = harness();
  await handlers.get('export:start')!(null, {runDir:'/A',testScript:'process.exit(1)'});
  await until(() => context.backgroundExport === null);
  assert.equal(handlers.get('export:status')!().status, 'error');
  assert.match(handlers.get('export:status')!().error, /failed/);
  assert.doesNotThrow(() => context.assertRunEditable('/A'));
});

test('export completion/error/cancel events never navigate or overwrite the other editor', () => {
  const ts = require('typescript');
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const begin = appSource.indexOf('    return window.catcut.onJobEvent((event) => {');
  const end = appSource.indexOf('\n  }, [electronReady]);', begin);
  let callback: any;
  let status: any;
  const context = vm.createContext({
    window: {catcut: {
      onJobEvent: (fn: any) => {callback=fn;},
      listProjects: async () => ({projects:[]}),
    }},
    setBackgroundExport: (value: any) => { status=value; },
    setExportCancelling() {}, setProjects() {},
    setRunning() { throw new Error('Foreground processing was changed'); },
    setReviewState() { throw new Error('Editor was closed'); },
    setTranscriptState() { throw new Error('Other transcript was replaced'); },
    setError() { throw new Error('Export error leaked into other editor'); },
  });
  const program = 'function subscribe(){let receivedExportEvent=false;\n'+appSource.slice(begin,end)+'\n}\nsubscribe();';
  vm.runInContext(ts.transpile(program),context);
  for (const type of ['job:done','job:error','job:cancelled','export:progress']) {
    callback({type,backgroundExport:true,exportStatus:{runDir:'/A',status:type}});
    assert.equal(status.runDir,'/A');
  }
});

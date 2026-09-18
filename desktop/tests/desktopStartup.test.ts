import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import http from 'node:http';
import { runDesktopSession } from '../scripts/desktopSession.mjs';

const require = createRequire(import.meta.url);
const { resolveDesktopOrigin, installDesktopOriginProxy } = require('../main/desktopOrigin.cjs');
const bootstrap = readFileSync(new URL('../main/bootstrap.cjs', import.meta.url), 'utf8');

test('起動先は割り当てられたlocalhost originのみ受け付ける', () => {
  assert.equal(resolveDesktopOrigin('http://127.0.0.1:43123'), 'http://127.0.0.1:43123');
  assert.equal(resolveDesktopOrigin(undefined), 'http://127.0.0.1:5174');
  for (const url of ['https://example.com:43123', 'http://localhost:43123', 'file:///tmp/x',
    'http://user@127.0.0.1:43123', 'http://127.0.0.1:43123/other', 'http://127.0.0.1:43123/?q=x']) {
    assert.throws(() => resolveDesktopOrigin(url));
  }
});

test('画面の保存先originを保ちながら自分のサーバーへ転送し、音声のRange要求も保持する', async () => {
  let handler: (request: Request) => Promise<Response> = async () => new Response();
  const forwarded: Request[] = [];
  const stableOrigin = installDesktopOriginProxy({ handle(name: string, callback: typeof handler) {
    assert.equal(name, 'http'); handler = callback;
  } }, async (request: Request, options: any) => {
    assert.equal(options.bypassCustomProtocolHandlers, true);
    forwarded.push(request); return new Response('ok');
  }, 'http://127.0.0.1:45123');
  assert.equal(stableOrigin, 'http://127.0.0.1:5174');
  await handler(new Request('http://127.0.0.1:5174/src/main.tsx?v=123'));
  assert.equal(forwarded[0].url, 'http://127.0.0.1:45123/src/main.tsx?v=123');
  await handler(new Request('http://127.0.0.1:45678/media?id=1', { headers: { Range: 'bytes=100-199' } }));
  assert.equal(forwarded[1].url, 'http://127.0.0.1:45678/media?id=1');
  assert.equal(forwarded[1].headers.get('Range'), 'bytes=100-199');
  await handler(new Request('http://127.0.0.1:5174/action', { method: 'POST', body: 'test' }));
  assert.equal(forwarded[2].method, 'POST'); assert.equal(await forwarded[2].text(), 'test');
});

test('通常ポートの場合は余分な転送処理を登録しない', () => {
  assert.equal(installDesktopOriginProxy({ handle() { throw Error('unnecessary proxy'); } }, null, 'http://127.0.0.1:5174'), 'http://127.0.0.1:5174');
});

function childProcess() {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kills: [] as string[],
    kill(signal: string) { this.kills.push(signal); queueMicrotask(() => this.emit('exit', null, signal)); return true; },
  });
  return child;
}

function serverFixture() {
  const server = http.createServer((_req, res) => res.end('Cat-Cut QA'));
  let closed = 0;
  return {
    httpServer: server,
    listen: () => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)),
    close: () => new Promise<void>(resolve => { closed++; server.close(() => resolve()); }),
    get closed() { return closed; },
  };
}

test('自身のサーバーがlistenしてから正確なURLで起動し、終了後にポートを解放する', async () => {
  const server = serverFixture(), signals = new EventEmitter(), child = childProcess();
  let url = '';
  const code = await runDesktopSession({ createServer: async () => server, signals, log() {},
    launchElectron(origin: string) {
      assert.equal(server.httpServer.listening, true);
      url = origin;
      assert.equal(origin, `http://127.0.0.1:${(server.httpServer.address() as any).port}`);
      fetch(origin).then(res => res.text()).then(body => { assert.equal(body, 'Cat-Cut QA'); child.emit('exit', 0); });
      return child;
    },
  });
  assert.equal(code, 0);
  assert.equal(server.closed, 1);
  assert.equal(server.httpServer.listening, false);
  await assert.rejects(fetch(url));
  assert.deepEqual(signals.eventNames(), []);
  assert.deepEqual(child.kills, []);
});

test('Electron起動失敗と非ゼロ終了でも自分のサーバーを閉じる', async () => {
  for (const mode of ['throw', 'error', 'exit']) {
    const server = serverFixture(), child = childProcess(), signals = new EventEmitter();
    const run = runDesktopSession({ createServer: async () => server, signals, log() {},
      launchElectron() {
        if (mode === 'throw') throw new Error('missing Electron');
        queueMicrotask(() => mode === 'error' ? child.emit('error', new Error('spawn failed')) : child.emit('exit', 7));
        return child;
      },
    });
    if (mode === 'exit') assert.equal(await run, 7);
    else await assert.rejects(run, /missing Electron|spawn failed/);
    assert.equal(server.closed, 1);
    assert.deepEqual(signals.eventNames(), []);
  }
});

test('サーバー起動失敗時にはElectronを起動せず後始末する', async () => {
  const signals = new EventEmitter(); let closed = false;
  await assert.rejects(runDesktopSession({ signals, log() {},
    createServer: async () => ({ listen: async () => { throw Error('listen failed'); }, close: async () => { closed = true; } }),
    launchElectron() { throw Error('must not launch'); },
  }), /listen failed/);
  assert.equal(closed, true); assert.deepEqual(signals.eventNames(), []);
});

test('SIGINT/TERM/HUPは自分の子だけ終了し、サーバーを閉じる', async () => {
  for (const [name, expected] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    const server = serverFixture(), signals = new EventEmitter(), child = childProcess();
    const code = await runDesktopSession({ signals, log() {}, createServer: async () => server,
      launchElectron() { queueMicrotask(() => signals.emit(name)); return child; },
    });
    assert.equal(code, expected); assert.equal(server.closed, 1); assert.deepEqual(child.kills, ['SIGTERM']);
    assert.deepEqual(signals.eventNames(), []);
  }
});

test('初期化中のキャンセルは起動を取り消し、後から完成したサーバーも閉じる', async () => {
  const signals = new EventEmitter(), server = serverFixture();
  let resolveServer: (value: typeof server) => void = () => {};
  const run = runDesktopSession({ signals, log() {}, createServer: () => new Promise(resolve => { resolveServer = resolve; }),
    launchElectron() { throw Error('must not launch'); },
  });
  signals.emit('SIGINT'); resolveServer(server);
  assert.equal(await run, 130); assert.equal(server.closed, 1);
});

test('終了に応答しない自分の子だけを期限後に終了し、重複シグナルも安全に扱う', async () => {
  const signals = new EventEmitter(), server = serverFixture(), child = childProcess();
  child.kill = (signal: string) => {
    child.kills.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  const code = await runDesktopSession({ signals, log() {}, stopTimeoutMs: 5, createServer: async () => server,
    launchElectron() { queueMicrotask(() => { signals.emit('SIGINT'); signals.emit('SIGTERM'); }); return child; },
  });
  assert.equal(code, 130); assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']); assert.equal(server.closed, 1);
});

test('サーバー生成に失敗してもプロセスにシグナルハンドラを残さない', async () => {
  const signals = new EventEmitter();
  await assert.rejects(runDesktopSession({ signals, createServer: async () => { throw Error('config failed'); },
    launchElectron() { throw Error('must not launch'); },
  }), /config failed/);
  assert.deepEqual(signals.eventNames(), []);
});

function bootstrapFixture(lock: boolean, windows: any[]) {
  const counts = { init: 0, quit: 0, activate: 0, focus: 0 };
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => lock,
    quit: () => { counts.quit++; }, whenReady: () => Promise.resolve(), focus: () => { counts.focus++; },
  });
  app.on('activate', () => { counts.activate++; });
  runInNewContext(bootstrap, { process: {}, console: { log() {} }, require(name: string) {
    if (name === 'electron') return { app, BrowserWindow: { getAllWindows: () => windows } };
    assert.equal(name, './index.cjs'); counts.init++; return {};
  } });
  return { app, counts };
}

test('二重起動側は本体・保存・サーバーを初期化しない', () => {
  const { counts } = bootstrapFixture(false, []);
  assert.equal(counts.quit, 1); assert.equal(counts.init, 0);
});

test('既存の最小化画面を復帰・前面化し、閉じている場合は再表示する', async () => {
  const actions: string[] = [];
  const windows = [{ isDestroyed: () => false, isMinimized: () => true,
    restore: () => actions.push('restore'), show: () => actions.push('show'), focus: () => actions.push('focus') }];
  const { app, counts } = bootstrapFixture(true, windows);
  app.emit('second-instance'); await Promise.resolve();
  assert.deepEqual(actions, ['restore', 'show', 'focus']);
  assert.equal(counts.init, 1); assert.equal(counts.focus, 1);
  windows.length = 0;
  app.emit('second-instance'); await Promise.resolve();
  assert.equal(counts.activate, 1); assert.equal(counts.init, 1);
});

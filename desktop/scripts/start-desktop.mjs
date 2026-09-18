import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runDesktopSession } from './desktopSession.mjs';

const desktopDir = fileURLToPath(new URL('../', import.meta.url));
// npmや親ターミナルのElectron用環境変数を引き継いでNodeモードで起動しない。
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_OVERRIDE_DIST_PATH;
const require = createRequire(import.meta.url);

try {
  const electronPath = require('electron');
  process.exitCode = await runDesktopSession({
    createServer: () => createServer({
      root: desktopDir,
      // Viteがbind成功まで空きポートを順に試す。空きを先に探して解放する競合を避ける。
      server: { host: '127.0.0.1', port: 5174, strictPort: false, open: false },
    }),
    launchElectron: (url) => spawn(electronPath, ['.'], {
      cwd: desktopDir,
      env: { ...process.env, CATCUT_DEV_SERVER_URL: url },
      // 親が強制終了された場合もElectronに切断を通知し、画面だけ残る状態を防ぐ。
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    }),
  });
} catch (error) {
  console.error('Cat-Cutを起動できませんでした:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

/** ViteとElectronを一組で管理する。他プロセスのポートやPIDには触れない。 */
export async function runDesktopSession({ createServer, launchElectron, signals = process, log = console.log, stopTimeoutMs = 5000 }) {
  let server;
  let child;
  let stopCode = null;
  let forceStop;
  const handlers = new Map();
  const stop = (code) => {
    if (stopCode !== null) return;
    stopCode = code;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      forceStop = setTimeout(() => child.kill('SIGKILL'), stopTimeoutMs);
      forceStop.unref?.();
    }
  };
  for (const [name, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const handler = () => stop(code);
    handlers.set(name, handler);
    signals.on(name, handler);
  }
  try {
    server = await createServer();
    if (stopCode !== null) return stopCode;
    await server.listen();
    if (stopCode !== null) return stopCode;
    const address = server.httpServer.address();
    if (!address || typeof address === 'string' || address.port <= 0) {
      throw new Error('編集画面の起動先を取得できませんでした。');
    }
    const url = `http://127.0.0.1:${address.port}`;
    log(`Cat-Cut 編集画面: ${url}`);
    child = launchElectron(url);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal === 'SIGINT' ? 130 : 1)));
    });
    return stopCode ?? code;
  } finally {
    clearTimeout(forceStop);
    for (const [name, handler] of handlers) signals.removeListener(name, handler);
    if (server) await server.close();
  }
}

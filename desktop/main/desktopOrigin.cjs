const DESKTOP_ORIGIN = 'http://127.0.0.1:5174';

function resolveDesktopOrigin(value) {
  if (!value) return DESKTOP_ORIGIN;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('編集画面の起動先はローカルのHTTPサーバーである必要があります。');
  }
  return url.origin;
}

/** ポートが変わっても既存localStorageの確認済みチェック・フォント設定を保持する。 */
function installDesktopOriginProxy(protocol, fetch, serverOrigin) {
  const actualOrigin = resolveDesktopOrigin(serverOrigin);
  if (actualOrigin !== DESKTOP_ORIGIN) {
    // このElectronセッションだけで転送する。同じポートを使う他アプリへ接続しない。
    protocol.handle('http', (request) => {
      const url = new URL(request.url);
      const target = url.origin === DESKTOP_ORIGIN ? actualOrigin + url.pathname + url.search : request.url;
      return fetch(new Request(target, request), { bypassCustomProtocolHandlers: true });
    });
  }
  return DESKTOP_ORIGIN;
}
module.exports = { resolveDesktopOrigin, installDesktopOriginProxy };

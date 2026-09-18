const { app, BrowserWindow } = require('electron');

if (typeof process.send === 'function') process.once('disconnect', () => app.quit());

// 重複した起動ではIPC・保存処理・プレビューサーバーを初期化しない。
if (!app.requestSingleInstanceLock()) {
  console.log('起動済みのCat-Cutを表示します。');
  app.quit();
} else {
  app.on('second-instance', () => {
    app.whenReady().then(() => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (window) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      } else {
        app.emit('activate');
      }
      app.focus({ steal: true });
    });
  });
  require('./index.cjs');
}

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** APIキーや編集本文を含むoptions全体は記録しない。ログ保存失敗で書き出しを止めない。 */
function createExportDiagnostics(runDir, options = {}) {
  const target = path.join(runDir, 'export-diagnostic.json');
  const state = {
    startedAt: new Date().toISOString(), status: 'starting',
    platform: process.platform, arch: process.arch, osRelease: os.release(),
    totalMemoryBytes: os.totalmem(), freeMemoryAtStartBytes: os.freemem(),
    node: process.versions.node, electron: process.versions.electron,
    settings: { renderConcurrency: options.renderConcurrency || 4, hardwareAcceleration: options.hardwareAcceleration || 'disable', targetShortSide: options.targetShortSide || 0 },
  };
  function save() {
    try {
      fs.writeFileSync(target + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(target + '.tmp', target);
    } catch { /* pipeline.log remains the primary process log */ }
  }
  save();
  return {
    record(event) {
      if (event.type === 'step:start') { state.status = 'running'; state.step = event.stepId; }
      else if (event.type === 'job:error') { state.status = 'failed'; state.error = String(event.error || 'Unknown error'); }
      else if (event.type === 'job:done') state.status = 'completed';
      else if (event.type === 'job:cancelled') state.status = 'cancelled';
      else return;
      state.updatedAt = new Date().toISOString();
      state.freeMemoryBytes = os.freemem();
      save();
    },
  };
}
module.exports = { createExportDiagnostics };

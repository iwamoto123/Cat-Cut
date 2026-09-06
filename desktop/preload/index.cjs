const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("catcut", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (input) => ipcRenderer.invoke("settings:save", input),
  listFontProfiles: () => ipcRenderer.invoke("font-profiles:list"),
  saveFontProfile: (input) => ipcRenderer.invoke("font-profiles:save", input),
  deleteFontProfile: (profileId) => ipcRenderer.invoke("font-profiles:delete", profileId),
  getTelopPresets: () => ipcRenderer.invoke("telop-presets:list"),
  getTelopTypeMapping: () => ipcRenderer.invoke("telop-type-mapping:get"),
  saveTelopTypeMapping: (input, extras) => ipcRenderer.invoke("telop-type-mapping:save", input, extras),
  // フェーズU7/U8: 現在の選択(テーマ or スタンダード)のシーンタイトル・OP設定
  getDesignExtras: () => ipcRenderer.invoke("design-extras:get"),
  // フェーズV2: run単位のOP設定(runs/<run>/op_config.json。このrunのOPの正本)
  getOpConfig: (runDir) => ipcRenderer.invoke("op-config:get", runDir),
  saveOpConfig: (input) => ipcRenderer.invoke("op-config:save", input),
  getDesignScenes: () => ipcRenderer.invoke("design-scenes:list"),
  listDesignThemes: () => ipcRenderer.invoke("design-themes:list"),
  saveDesignTheme: (input) => ipcRenderer.invoke("design-themes:save", input),
  deleteDesignTheme: (themeId) => ipcRenderer.invoke("design-themes:delete", themeId),
  getUserRules: () => ipcRenderer.invoke("user-rules:get"),
  saveUserRules: (input) => ipcRenderer.invoke("user-rules:save", input),
  learnDictionaryRule: (input) => ipcRenderer.invoke("user-rules:learnDictionary", input),
  getUserDictionary: () => ipcRenderer.invoke("user-dictionary:get"),
  saveUserDictionaryEntry: (input) => ipcRenderer.invoke("user-dictionary:save", input),
  deleteUserDictionaryEntry: (from) => ipcRenderer.invoke("user-dictionary:delete", from),
  // W14-2: 編集前→編集後の修正ペア学習(edit_history.json / correction_history.json)
  recordTelopEditLearning: (input) => ipcRenderer.invoke("edit-learning:record", input),
  loadEditHistory: (runDir) => ipcRenderer.invoke("edit-history:load", runDir),
  getCorrectionHistory: () => ipcRenderer.invoke("correction-history:get"),
  deleteCorrectionHistoryPair: (input) => ipcRenderer.invoke("correction-history:delete", input),
  exportLearningData: () => ipcRenderer.invoke("edit-learning:export"),
  recordLearningDecision: (input) => ipcRenderer.invoke("user-rules:recordDecision", input),
  chooseVideo: () => ipcRenderer.invoke("dialog:chooseVideo"),
  // フェーズW8: 素材選択直後の縦横自動判定(ffprobe)
  probeVideo: (videoPath) => ipcRenderer.invoke("video:probe", videoPath),
  chooseGroundTruthText: () => ipcRenderer.invoke("ground-truth:choose"),
  analyzeGroundTruthRules: (input) => ipcRenderer.invoke("ground-truth:analyze", input),
  applyGroundTruthRuleProposal: (input) => ipcRenderer.invoke("ground-truth:apply-rule-proposal", input),
  applyGroundTruthText: (input) => ipcRenderer.invoke("ground-truth:apply", input),
  chooseOutputDirectory: () => ipcRenderer.invoke("dialog:chooseOutputDirectory"),
  saveOutputFile: (input) => ipcRenderer.invoke("dialog:saveOutputFile", input),
  startJob: (options) => ipcRenderer.invoke("job:start", options),
  startExport: (options) => ipcRenderer.invoke("export:start", options),
  cancelJob: () => ipcRenderer.invoke("job:cancel"),
  loadTelop: (runDir) => ipcRenderer.invoke("telop:load", runDir),
  loadTranscriptEditor: (runDir) => ipcRenderer.invoke("transcript:load", runDir),
  saveSceneEditsDraft: (input) => ipcRenderer.invoke("scene-edits:save-draft", input),
  loadSceneEditsDraft: (runDir) => ipcRenderer.invoke("scene-edits:load-draft", runDir),
  applyTranscriptEdits: (input) => ipcRenderer.invoke("transcript:apply", input),
  runTranscriptCommand: (input) => ipcRenderer.invoke("transcript:run-command", input),
  generateWaveform: (input) => ipcRenderer.invoke("transcript:waveform", input),
  // フェーズU9: フィルムストリップ(サムネイル帯)とBGMトラック
  generateFilmstrip: (input) => ipcRenderer.invoke("transcript:filmstrip", input),
  listBgm: (input) => ipcRenderer.invoke("bgm:list", input),
  addBgm: (input) => ipcRenderer.invoke("bgm:add", input),
  saveBgm: (input) => ipcRenderer.invoke("bgm:save", input),
  // フェーズV4: 画像挿入トラック
  listImages: (input) => ipcRenderer.invoke("images:list", input),
  addImage: (input) => ipcRenderer.invoke("images:add", input),
  saveImages: (input) => ipcRenderer.invoke("images:save", input),
  // フェーズV6-4(D&D): ダイアログなし版の追加IPC。パス+開始msを直接渡す
  addBgmFile: (input) => ipcRenderer.invoke("bgm:add-file", input),
  addImageFile: (input) => ipcRenderer.invoke("images:add-file", input),
  // フェーズW9: 映像フレーミング(変形・クロップ)。run正本 video_framing.json
  getVideoFraming: (input) => ipcRenderer.invoke("video-framing:get", input),
  saveVideoFraming: (input) => ipcRenderer.invoke("video-framing:save", input),
  // フェーズV6-4(D&D): Electron 32以降 File.path が廃止されたため、ドロップされた
  // FileオブジェクトのOSパスは preload の webUtils.getPathForFile でしか取れない
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveTelop: (input) => ipcRenderer.invoke("telop:save", input),
  applyFontDirectives: (input) => ipcRenderer.invoke("font:apply", input),
  applyTelopStyle: (input) => ipcRenderer.invoke("telop-style:apply", input),
  getOllamaStatus: () => ipcRenderer.invoke("ollama:status"),
  pullOllamaModel: (input) => ipcRenderer.invoke("ollama:pull", input),
  reviewTelopWithOllama: (input) => ipcRenderer.invoke("ollama:review-telop", input),
  openOllamaInstallGuide: () => ipcRenderer.invoke("ollama:openInstallGuide"),
  // W13-1: キャッシュ管理(派生キャッシュの統計・削除)
  getCacheStats: () => ipcRenderer.invoke("cache:stats"),
  cleanCache: (input) => ipcRenderer.invoke("cache:clean", input),
  // フェーズW7: プロジェクト一覧(runs/を「プロジェクト」として一覧・保存・削除)
  listProjects: () => ipcRenderer.invoke("projects:list"),
  saveProjectMeta: (input) => ipcRenderer.invoke("projects:save-meta", input),
  deleteProject: (input) => ipcRenderer.invoke("projects:delete", input),
  revealPath: (targetPath) => ipcRenderer.invoke("path:reveal", targetPath),
  openPath: (targetPath) => ipcRenderer.invoke("path:open", targetPath),
  getApiKeysStatus: () => ipcRenderer.invoke("api-keys:status"),
  setApiKey: (input) => ipcRenderer.invoke("api-keys:set", input),
  deleteApiKey: (input) => ipcRenderer.invoke("api-keys:delete", input),
  testApiKey: (input) => ipcRenderer.invoke("api-keys:test", input),
  openExternalUrl: (url) => ipcRenderer.invoke("shell:openExternal", url),
  // W12-2: ライセンス(FEATURES.billing ONで使用。キー認証・解除・状態更新・購入)
  getLicense: () => ipcRenderer.invoke("license:get"),
  activateLicense: (input) => ipcRenderer.invoke("license:activate", input),
  deactivateLicense: () => ipcRenderer.invoke("license:deactivate"),
  refreshLicense: () => ipcRenderer.invoke("license:refresh"),
  startLicenseCheckout: (input) => ipcRenderer.invoke("license:checkout", input),
  onJobEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("job:event", handler);
    return () => ipcRenderer.removeListener("job:event", handler);
  },
  // W16-7: AI最終チェック(現在の表示テキスト全シーンのLLM再チェック)
  runFinalTextCheck: (input) => ipcRenderer.invoke("final-check:run", input),
  // W19-B2: 保存済みAI最終チェック結果(issues.json)の自動ロード
  loadFinalTextCheck: (runDir) => ipcRenderer.invoke("final-check:load", runDir),
  // W16-6: スリープ・画面ロック通知(renderer側はプレビュー再生を一時停止する)
  onPowerSuspend: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("power:suspend", handler);
    return () => ipcRenderer.removeListener("power:suspend", handler);
  },
  // W19-C5: 適用(step08セグメント抽出)中の進捗(0〜100%)。適用中インジケータに表示する
  onApplyProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("apply:progress", handler);
    return () => ipcRenderer.removeListener("apply:progress", handler);
  },
});

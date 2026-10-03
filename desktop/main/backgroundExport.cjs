"use strict";

function reduceExportStatus(previous, event) {
  const state = previous || { runDir: event.exportRunDir, status: "running", percent: 0, step: "書き出し準備", error: "", finalVideo: "" };
  if (event.type === "export:start") return { ...state, runDir: event.exportRunDir, status: "running" };
  if (event.type === "step:start") return { ...state, step: event.stepId };
  if (event.type === "export:progress") return { ...state, percent: Math.max(0, Math.min(100, event.percent)) };
  if (event.type === "job:done") return { ...state, status: "done", percent: 100, finalVideo: event.outputs.finalVideo };
  if (event.type === "job:error") return { ...state, status: "error", error: event.error };
  if (event.type === "job:cancelled") return { ...state, status: "cancelled" };
  return state;
}

module.exports = { reduceExportStatus };

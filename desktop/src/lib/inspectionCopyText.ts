import type { Scene } from "./scenes.ts";
import type { SuspicionItem } from "./suspicionQueue.ts";

/** 検品テキスト用の時間表示 `[MM:SS.CC]`（centisecond = 10ms 単位）。 */
export function formatInspectionTimeMs(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const centiseconds = Math.floor((clamped % 1000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function formatInspectionDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

/** シーンに紐づく疑義を `[警告: ラベル Nms]` 形式へ。複数ある場合はスペース区切り。 */
export function formatSceneWarningSuffix(suspicions: SuspicionItem[]): string {
  if (!suspicions.length) return "";
  return suspicions
    .map((item) => {
      const msMatch = /(\d+)ms/.exec(item.detail);
      const msPart = msMatch ? ` ${msMatch[1]}ms` : item.detail ? ` ${item.detail}` : "";
      return `[警告: ${item.label}${msPart}]`;
    })
    .join(" ");
}

export type BuildInspectionCopyTextOptions = {
  runName: string;
  scenes: Scene[];
  suspicionsBySceneId: Map<string, SuspicionItem[]>;
  generatedAt?: Date;
};

/**
 * 改善9-B-1: 全シーンの検品情報をAIフィードバック用プレーンテキストへ整形する。
 */
export function buildInspectionCopyText(options: BuildInspectionCopyTextOptions): string {
  const { runName, scenes, suspicionsBySceneId } = options;
  const generatedAt = options.generatedAt ?? new Date();
  const header = `# Cat-Cut 検品テキスト (${runName} / ${formatInspectionDate(generatedAt)})`;
  const body = scenes.map((scene, index) => {
    const range = `[${formatInspectionTimeMs(scene.sourceStartMs)}-${formatInspectionTimeMs(scene.sourceEndMs)}]`;
    const warnings = formatSceneWarningSuffix(suspicionsBySceneId.get(scene.id) ?? []);
    return `${index + 1} ${range} ${scene.telopText}${warnings ? ` ${warnings}` : ""}`;
  });
  return [header, ...body].join("\n");
}

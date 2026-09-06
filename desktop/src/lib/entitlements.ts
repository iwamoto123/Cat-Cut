// W12-2: 機能ゲート(entitlements)の判定関数。
//
// どの機能をどのライセンス状態で制限するかのポリシーは金額決定時に確定するため、
// 現時点では全て true を返す(=一切制限しない)。呼び出し規約だけを先に固定し、
// UI側は将来もこの関数群を経由して判定する。ポリシー決定後はこのファイルの
// 実装とテストだけを更新すればよい。
import type { LicenseStatus } from "./license.ts";

/** アプリ本体(検品・編集)を使えるか。 */
export function canUseApp(_status: LicenseStatus): boolean {
  return true;
}

/** MP4書き出しができるか。 */
export function canExport(_status: LicenseStatus): boolean {
  return true;
}

/** AI校正・AIレビュー等のAI機能を使えるか。 */
export function canUseAiFeatures(_status: LicenseStatus): boolean {
  return true;
}

// フェーズV6-4(画像・BGMのドラッグ&ドロップ): OSからのファイルドラッグの振り分けと
// ドロップ位置(タイムラインms)計算の純関数。dragover中はファイル名が取れない
// (DataTransferItemはMIMEタイプのみ公開)ため、インジケータ表示はMIMEで判定し、
// drop確定時は拡張子で最終判定する(拡張子が正、MIMEはOS依存で欠けることがあるため)。
//
// 実行時(値)importのため、node --experimental-strip-types でテストを直接実行できるよう拡張子を明示する。

export type DropMediaKind = "image" | "bgm";

/** 受け付ける画像拡張子(main側 IMAGE_FILE_EXTENSIONS と同値)。 */
export const DROP_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
/** 受け付ける音声拡張子(main側 BGM_AUDIO_EXTENSIONS と同値)。 */
export const DROP_AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac"];

/** ファイル名(拡張子)→振り分け先。対象外はnull(「非対応の形式」表示)。 */
export function classifyDropFileName(fileName: string): DropMediaKind | null {
  const match = /\.([^.]+)$/.exec(fileName.trim().toLowerCase());
  if (!match) return null;
  const ext = match[1];
  if (DROP_IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (DROP_AUDIO_EXTENSIONS.includes(ext)) return "bgm";
  return null;
}

/**
 * dragover中のMIMEタイプ→振り分け先。image/* は画像、audio/* はBGM。
 * MIME不明(空文字。OS/ブラウザ依存)は「ドロップしてみないと分からない」ためnull扱いにせず
 * 呼び出し側でunknown表示にできるようnullを返す(表示はdrop時に拡張子で確定する)。
 */
export function classifyDropMimeType(mimeType: string): DropMediaKind | null {
  const lower = mimeType.trim().toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("audio/")) return "bgm";
  return null;
}

/** ドロップX座標(キャンバス左端基準px)→タイムラインms。0未満は0へクランプ。 */
export function dropTimelineMs(offsetXPx: number, pxPerMs: number): number {
  if (pxPerMs <= 0) return 0;
  return Math.max(0, Math.round(offsetXPx / pxPerMs));
}

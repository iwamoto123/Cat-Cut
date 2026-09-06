/**
 * フェーズW14-1: シーン一覧の自動追従スクロール抑制フラグ(playbackScrollSuppressed)の遷移を
 * 1か所に集約する純関数。W5-7(要確認パネル発の再生)で導入した抑制機構を、OP行
 * (OpClipRows)の再生・波形クリックシーク・幅変更ドラッグにも拡張する。
 *
 * 「OPの再生やシーン幅変更はあくまでOPのところだけで操作したい」という実機FBのとおり、
 * OP行の操作では再生ヘッドが本編シーン位置へ移動しても一覧をスクロールさせない。
 * 通常のシーン行再生・明示的なシーンジャンプでは従来どおり追従へ復帰する。
 */

/** 再生ヘッド移動を伴う操作の発生源。 */
export type PlaybackScrollSource =
  /** 通常のシーン行再生(従来どおり自動追従する)。 */
  | "scene-row"
  /** W5-7: 要確認パネル発の再生(パネルを見たまま聴くため追従しない)。 */
  | "hotspot-panel"
  /** W14-1: OP行の再生・波形クリックシーク・幅変更ドラッグ(OPの場所に留まりたいので追従しない)。 */
  | "op-row"
  /** 明示的なシーンジャンプ(「シーンNへ」ボタン等。行を見せるのが目的なので追従へ復帰する)。 */
  | "jump-to-scene";

/** 操作の発生源から、次の playbackScrollSuppressed 値を決める。 */
export function playbackScrollSuppressedFor(source: PlaybackScrollSource): boolean {
  return source === "hotspot-panel" || source === "op-row";
}

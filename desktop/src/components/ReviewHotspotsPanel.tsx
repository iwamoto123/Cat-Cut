import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Play,
  Wand2,
} from "lucide-react";
import type { Scene } from "../lib/scenes";
import type { ReviewHotspot } from "../lib/reviewHotspots";
import type { SuspicionItem } from "../lib/suspicionQueue";

/**
 * フェーズW5-5/W5-8: 要確認パネル。確認すべきシーンをシーン検品リストの上部に常設表示する。
 * 各カードには本物のSceneRow(renderSceneRowでApp側から注入)を埋め込み、チップのホバー
 * キャレット・クリック再生バー確定・右クリック削除・textarea改行編集・一括置換など、
 * 通常のシーン検品と完全に同じ編集動作を提供する。パネル内のSceneRowは
 * autoScrollDisabled(自動追従スクロールなし)+再生はそのクリップのみ、という点だけが異なる。
 */

type Props = {
  hotspots: ReviewHotspot[];
  /** 「シーンXへ」ボタンで下のシーン一覧の該当行へジャンプする(行が2秒フラッシュ)。 */
  onJumpToScene: (scene: Scene) => void;
  /** W5-8: カード左端の再生ボタン(このシーンだけ再生。自動追従スクロールなし)。 */
  onPlayScene: (scene: Scene) => void;
  /** 「候補: ○○ [適用]」用。テロップ編集フォーカス開始(編集前テキストのスナップショット取得)。 */
  onTelopFocus: (sceneId: string, text: string) => void;
  /** 「候補: ○○ [適用]」用。テロップ本文の書き換え(scenesHistory.setTelopText)。 */
  onTelopChange: (sceneId: string, text: string) => void;
  /** 「候補: ○○ [適用]」用。テロップ編集確定(一括置換候補の検出)。 */
  onTelopBlur: (sceneId: string) => void;
  /** App側から本物のSceneRow(通常一覧と同じ配線+autoScrollDisabled)を注入する。 */
  renderSceneRow: (scene: Scene, ordinal: number) => ReactNode;
  /** W16-7: AI最終チェックの指摘の「無視」(このrunの間は再表示しない)。 */
  onIgnoreItem?: (item: SuspicionItem) => void;
  /** W19-B3: 「AI修正を一括適用(N件)」の適用可能件数(0なら無効化)。 */
  bulkApplyCount?: number;
  /** W19-B3: 一括適用の実行(App側が1つのUndoエントリでコミットしトーストを出す)。 */
  onBulkApplyAiFixes?: () => void;
  /** W28: 「確認済み」チェック。チェックしたカードだけ要確認から消す(自動では消えない)。 */
  onResolveScene: (sceneId: string) => void;
  /** W28: 確認済みにしたカード数(「N件を戻す」表示用)。 */
  resolvedCount: number;
  /** W28: 確認済みチェックを全解除して戻す。 */
  onRestoreResolved: () => void;
};

/** W16-7/W19-B1: 「無視」ボタンを出せる種別(AI由来の指摘で誤指摘対策が必要なもの)。 */
const IGNORABLE_TYPES = new Set(["final_check", "retranscribe"]);

/** カードのメタ行に出す種別バッジ(同一labelは1つに集約)。 */
function uniqueLabels(items: SuspicionItem[]): Array<{ label: string; severity: string }> {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (!seen.has(item.label)) seen.set(item.label, item.severity);
  }
  return [...seen.entries()].map(([label, severity]) => ({ label, severity }));
}

function uniqueDetails(items: SuspicionItem[]): string[] {
  return [...new Set(items.map((item) => item.detail).filter(Boolean))];
}

function HotspotCard({
  hotspot,
  onJumpToScene,
  onPlayScene,
  onTelopFocus,
  onTelopChange,
  onTelopBlur,
  renderSceneRow,
  onIgnoreItem,
  onResolveScene,
}: { hotspot: ReviewHotspot } & Omit<
  Props,
  | "hotspots"
  | "bulkApplyCount"
  | "onBulkApplyAiFixes"
  | "resolvedCount"
  | "onRestoreResolved"
>) {
  const { scene, sceneOrdinal, items } = hotspot;
  const suggestionItems = items.filter(
    (item) => item.suggestion && item.text && scene.telopText.includes(item.text),
  );
  // W16-7/W19-B1: AI最終チェック・再文字起こしの指摘は「無視」で個別に消せる(誤指摘対策)。
  const ignorableItems = onIgnoreItem ? items.filter((item) => IGNORABLE_TYPES.has(item.type)) : [];

  /**
   * 「候補: ○○ [適用]」: フォーカススナップショットを適用前テキストで登録してから置換する
   * (=既存のhandleTelopBlurが差分から一括置換候補を検出し、TelopReplaceModalが正しく開く)。
   * onTelopBlurはsetStateの反映後(次のタスク)に発火させる(親は最新のscenesから差分を読むため)。
   */
  function applySuggestion(item: SuspicionItem) {
    if (!item.suggestion || !item.text) return;
    onTelopFocus(scene.id, scene.telopText);
    onTelopChange(scene.id, scene.telopText.split(item.text).join(item.suggestion));
    window.setTimeout(() => onTelopBlur(scene.id), 0);
  }

  return (
    <div className="reviewHotspotCard" data-scene-id={scene.id}>
      <div className="reviewHotspotMeta">
        <button
          className="reviewHotspotPlayButton"
          onClick={() => onPlayScene(scene)}
          title="このシーンだけ再生します(行末で自動停止)"
          type="button"
        >
          <Play size={12} />
        </button>
        <button
          className="reviewHotspotJumpButton"
          onClick={() => onJumpToScene(scene)}
          title="下のシーン一覧の該当行へジャンプします(行が2秒間ハイライトされます)"
          type="button"
        >
          <span>シーン{sceneOrdinal}へ</span>
          <ArrowDown size={12} />
        </button>
        {uniqueLabels(items).map(({ label, severity }) => (
          <span className={`sceneSuspicionBadge ${severity}`} key={label}>
            {label}
          </span>
        ))}
        <span className="reviewHotspotDetail">{uniqueDetails(items).join(" / ")}</span>
        {suggestionItems.map((item) => (
          <button
            className="reviewHotspotSuggestionButton"
            key={item.id}
            onClick={() => applySuggestion(item)}
            title={`「${item.text}」を「${item.suggestion}」に置き換えます`}
            type="button"
          >
            候補: {item.suggestion} [適用]
          </button>
        ))}
        {ignorableItems.map((item) => (
          <button
            className="reviewHotspotIgnoreButton"
            key={`ignore-${item.id}`}
            onClick={() => onIgnoreItem?.(item)}
            title={`「${item.text}」への指摘を無視します(再チェックまで再表示されません)`}
            type="button"
          >
            「{item.text}」を無視
          </button>
        ))}
        {/* W28: 確認済みチェック。編集で勝手に消える方式をやめ、ここにチェックを入れた
            カードだけ消す(ヘッダの「N件を戻す」で全部戻せる)。 */}
        <label
          className="reviewHotspotResolveCheck"
          title="チェックを入れるとこのカードを要確認から消します(ヘッダの「戻す」で再表示できます)"
        >
          <input checked={false} onChange={() => onResolveScene(scene.id)} type="checkbox" />
          <span>確認済み</span>
        </label>
      </div>
      {renderSceneRow(scene, sceneOrdinal)}
    </div>
  );
}

export function ReviewHotspotsPanel({
  hotspots,
  onJumpToScene,
  onPlayScene,
  onTelopFocus,
  onTelopChange,
  onTelopBlur,
  renderSceneRow,
  onIgnoreItem,
  bulkApplyCount = 0,
  onBulkApplyAiFixes,
  onResolveScene,
  resolvedCount,
  onRestoreResolved,
}: Props) {
  // W25: 折りたたみ状態を記憶する(2026-08-21 実機フィードバック「要確認は折りたためるように」。
  // トグル自体はW5からあったが気づかれず、毎回開いた状態に戻るのも不便だったため)。
  // 実機FB 2026-09-03: 左右レイアウト廃止で常に縦積みになったため、既定は折りたたみ
  // (ヘッダの件数だけ見せて、開いたときにOP・通常シーンの上へ縦に展開する)。
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("catcut.reviewHotspotsOpen") === "1";
    } catch {
      return false;
    }
  });
  const toggleOpen = () => {
    setOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem("catcut.reviewHotspotsOpen", next ? "1" : "0");
      } catch {
        // localStorage が使えない環境では記憶せず動作のみ
      }
      return next;
    });
  };
  const totalCount = hotspots.reduce((sum, hotspot) => sum + hotspot.items.length, 0);

  // W19-B3: 「AI修正を一括適用(N件)」ボタン(常設。0件なら無効化)。
  const bulkApplyButton = onBulkApplyAiFixes ? (
    <button
      className="reviewHotspotsBulkApplyButton"
      disabled={bulkApplyCount === 0}
      onClick={onBulkApplyAiFixes}
      title="AIの修正候補(候補付きの指摘)をまとめて本文へ適用します(Cmd+Zで一括で戻せます)"
      type="button"
    >
      <Wand2 size={13} />
      <span>AI修正を一括適用（{bulkApplyCount}件）</span>
    </button>
  ) : null;

  // W28: 「確認済みN件を戻す」(チェックの全解除)ボタン。
  // 実機FB 2026-09-03: 左右レイアウト切替は「横に並べると見づらい」ため廃止し、常に
  // 要確認→OP→通常シーンの縦積み(要確認は折りたたみで開閉)に一本化した。
  const restoreButton =
    resolvedCount > 0 ? (
      <button
        className="reviewHotspotsRestoreButton"
        onClick={onRestoreResolved}
        title="「確認済み」チェックを入れて消したカードをすべて戻します"
        type="button"
      >
        確認済み{resolvedCount}件を戻す
      </button>
    ) : null;

  if (!hotspots.length) {
    return (
      <div className="reviewHotspotsPanel reviewHotspotsPanelEmpty">
        <span className="reviewHotspotsEmptyText">要確認はありません</span>
        <div className="reviewHotspotsHeaderActions">
          {restoreButton}
          {bulkApplyButton}
        </div>
      </div>
    );
  }

  return (
    <div className="reviewHotspotsPanel">
      <div className="reviewHotspotsHeaderRow">
        <button
          className="reviewHotspotsHeader"
          onClick={toggleOpen}
          title={open ? "クリックで折りたたむ" : "クリックで開く"}
          type="button"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <AlertTriangle size={14} />
          <span>要確認 ({totalCount}件)</span>
          <span className="reviewHotspotsToggleHint">{open ? "折りたたむ" : "開く"}</span>
        </button>
        <div className="reviewHotspotsHeaderActions">
          {restoreButton}
          {bulkApplyButton}
        </div>
      </div>
      {open && (
        <div className="reviewHotspotsList">
          {hotspots.map((hotspot) => (
            <HotspotCard
              hotspot={hotspot}
              key={hotspot.scene.id}
              onIgnoreItem={onIgnoreItem}
              onJumpToScene={onJumpToScene}
              onPlayScene={onPlayScene}
              onResolveScene={onResolveScene}
              onTelopBlur={onTelopBlur}
              onTelopChange={onTelopChange}
              onTelopFocus={onTelopFocus}
              renderSceneRow={renderSceneRow}
            />
          ))}
        </div>
      )}
    </div>
  );
}

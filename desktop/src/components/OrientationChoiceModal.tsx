import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

/**
 * フェーズW8(素材選択時の縦横選択): 動画選択直後に出力キャンバスの向きを確認するモーダル。
 * 既定選択は ffprobe(video:probe)の自動判定。背景クリック/Escはキャンセル扱いで、
 * 親(App)は自動判定値をそのまま採用する(chooseVideo時点で既定値をstateへ入れておく)。
 */

type Props = {
  open: boolean;
  /** video:probe の結果(null=未取得)。既定選択と補足行の表示に使う。 */
  probe: CatCutVideoProbeResult | null;
  /** 現在の選択(チップから開き直した場合)。null なら probe の判定を既定にする。 */
  current: CatCutOrientation | null;
  onConfirm: (orientation: CatCutOrientation) => void;
  /** 背景クリック/Esc/閉じるボタン。親は現在値(自動判定既定)を維持する。 */
  onCancel: () => void;
};

export function orientationLabel(orientation: CatCutOrientation): string {
  return orientation === "vertical" ? "縦型 9:16" : "横型 16:9";
}

export function OrientationChoiceModal({ open, probe, current, onConfirm, onCancel }: Props) {
  const detected = probe && probe.ok ? probe.orientation : null;
  const [selected, setSelected] = useState<CatCutOrientation>("horizontal");

  // 開くたびに「現在の選択 > 自動判定 > 横型」の順で既定選択を作り直す
  useEffect(() => {
    if (!open) return;
    setSelected(current ?? detected ?? "horizontal");
  }, [open, current, detected]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onCancel]);

  if (!open) return null;

  const note =
    probe && probe.ok
      ? `素材は${probe.orientation === "vertical" ? "縦型" : "横型"}（${probe.displayWidth}×${probe.displayHeight}）と判定されました`
      : "素材の向きを自動判定できませんでした（横型を既定にしています）";

  const cards: Array<{ id: CatCutOrientation; title: string; description: string }> = [
    { id: "horizontal", title: "横型 16:9", description: "YouTubeなどの横長動画向け" },
    { id: "vertical", title: "縦型 9:16", description: "ショート・リールなどの縦長動画向け" },
  ];

  return (
    <div className="commandPaletteBackdrop" onClick={onCancel} role="presentation">
      <div className="orientationChoiceModal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="exportSettingsHeader">
          <span className="exportSettingsTitle">動画の向きを選択</span>
          <button className="exportSettingsCloseButton" onClick={onCancel} title="閉じる" type="button">
            <X size={16} />
          </button>
        </div>
        <div className="orientationChoiceBody">
          <div className="orientationChoiceCards">
            {cards.map((card) => (
              <button
                key={card.id}
                className={`orientationChoiceCard${selected === card.id ? " selected" : ""}`}
                onClick={() => setSelected(card.id)}
                type="button"
              >
                <span className={`orientationChoiceFrame${card.id === "vertical" ? " vertical" : ""}`} />
                <span className="orientationChoiceCardTitle">{card.title}</span>
                <span className="orientationChoiceCardDescription">{card.description}</span>
                {detected === card.id && <span className="orientationChoiceAutoBadge">自動判定</span>}
              </button>
            ))}
          </div>
          <p className="orientationChoiceNote">{note}</p>
        </div>
        <div className="exportSettingsFooter">
          <button className="secondaryButton" onClick={onCancel} type="button">
            キャンセル
          </button>
          <button className="primaryButton" onClick={() => onConfirm(selected)} type="button">
            <Check size={16} />
            <span>この向きで進める</span>
          </button>
        </div>
      </div>
    </div>
  );
}

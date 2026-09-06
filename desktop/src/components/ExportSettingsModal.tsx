import { useEffect, useState } from "react";
import { Download, FolderOpen, X } from "lucide-react";
import {
  EXPORT_HARDWARE_ENCODE_DEFAULT,
  EXPORT_QUALITY_OPTIONS,
  EXPORT_RENDER_SPEED_OPTIONS,
  EXPORT_RESOLUTION_OPTIONS,
  buildExportOutputPath,
  ensureMp4FileName,
  initialExportFileName,
  type ExportQuality,
  type ExportRenderSpeed,
  type ExportResolution,
} from "../lib/exportOptions";

/** フェーズW7: 「書き出し」ボタンで毎回開く書き出し設定モーダル。 */
export type ExportSettingsValue = {
  directory: string;
  fileName: string;
  resolution: ExportResolution;
  quality: ExportQuality;
  renderSpeed: ExportRenderSpeed;
  /** W11-1b: ハードウェアエンコード(VideoToolbox)。既定ON。 */
  hardwareEncode: boolean;
};

type Props = {
  open: boolean;
  videoPath: string;
  initialDirectory: string;
  onCancel: () => void;
  onSubmit: (value: ExportSettingsValue) => void;
};

export function ExportSettingsModal({ open, videoPath, initialDirectory, onCancel, onSubmit }: Props) {
  const [directory, setDirectory] = useState(initialDirectory);
  const [fileName, setFileName] = useState("");
  const [resolution, setResolution] = useState<ExportResolution>("source");
  const [quality, setQuality] = useState<ExportQuality>("standard");
  const [renderSpeed, setRenderSpeed] = useState<ExportRenderSpeed>("standard");
  const [hardwareEncode, setHardwareEncode] = useState(EXPORT_HARDWARE_ENCODE_DEFAULT);

  // 開くたびに下書きを作り直す。保存場所は前回値を引き継ぎ、
  // W11-4a: ファイル名は前回値ではなく現在runの元動画名から毎回生成する
  // (別プロジェクトの古い名前が残らない。元動画と同パスになる場合のみ _catcut 付き)。
  useEffect(() => {
    if (!open) return;
    setDirectory(initialDirectory);
    setFileName(initialExportFileName(videoPath, initialDirectory));
    setResolution("source");
    setQuality("standard");
    setRenderSpeed("standard");
    setHardwareEncode(EXPORT_HARDWARE_ENCODE_DEFAULT);
  }, [open, initialDirectory, videoPath]);

  if (!open) return null;

  const placeholder = initialExportFileName(videoPath, directory);
  const plannedPath = buildExportOutputPath(directory, fileName, videoPath);

  const chooseDirectory = async () => {
    const selected = await window.catcut.chooseOutputDirectory();
    if (!selected) return;
    setDirectory(selected);
    // W11-4a: ユーザーが手入力していない自動生成名のままなら、新しい保存場所で
    // 元動画との衝突を再判定して付け直す(手入力済みの名前は尊重する)
    setFileName((current) =>
      current === initialExportFileName(videoPath, directory) ? initialExportFileName(videoPath, selected) : current,
    );
  };

  return (
    <div className="commandPaletteBackdrop" onClick={onCancel} role="presentation">
      <div className="exportSettingsModal" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="exportSettingsHeader">
          <span className="exportSettingsTitle">書き出し設定</span>
          <button className="exportSettingsCloseButton" onClick={onCancel} title="閉じる" type="button">
            <X size={16} />
          </button>
        </div>
        <div className="exportSettingsBody">
          <label className="exportSettingsField">
            <span>保存場所</span>
            <div className="pathRow">
              <input readOnly value={directory || "未指定: 作業フォルダ内に保存"} />
              <button className="iconButton" onClick={chooseDirectory} title="保存場所を選択" type="button">
                <FolderOpen size={18} />
              </button>
            </div>
          </label>
          <label className="exportSettingsField">
            <span>ファイル名</span>
            <input
              onChange={(event) => setFileName(event.target.value)}
              placeholder={placeholder}
              value={fileName}
            />
          </label>
          <div className="exportSettingsRow">
            <label className="exportSettingsField">
              <span>解像度</span>
              <select onChange={(event) => setResolution(event.target.value as ExportResolution)} value={resolution}>
                {EXPORT_RESOLUTION_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="exportSettingsField">
              <span>画質</span>
              <select onChange={(event) => setQuality(event.target.value as ExportQuality)} value={quality}>
                {EXPORT_QUALITY_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="exportSettingsField">
            <span>書き出し速度</span>
            <div className="exportSettingsRadioGroup">
              {EXPORT_RENDER_SPEED_OPTIONS.map((option) => (
                <label className="exportSettingsRadioOption" key={option.id}>
                  <input
                    checked={renderSpeed === option.id}
                    name="exportRenderSpeed"
                    onChange={() => setRenderSpeed(option.id)}
                    type="radio"
                  />
                  <span className="exportSettingsRadioLabel">{option.label}</span>
                  <span className="exportSettingsRadioHint">{option.description}</span>
                </label>
              ))}
            </div>
            {/* W11-1b: HWエンコード(VideoToolbox)。OFFは従来のソフトウェアx264(比較検証用) */}
            <label className="exportSettingsRadioOption">
              <input
                checked={hardwareEncode}
                onChange={(event) => setHardwareEncode(event.target.checked)}
                type="checkbox"
              />
              <span className="exportSettingsRadioLabel">ハードウェアエンコード（Apple Silicon推奨・大幅高速化）</span>
              <span className="exportSettingsRadioHint">
                動画チップで最終エンコードします。OFFにすると従来のソフトウェア方式になります。
              </span>
            </label>
          </div>
          <div className="exportSettingsPathPreview" title={plannedPath || undefined}>
            {plannedPath ? `書き出し先: ${plannedPath}` : "書き出し先: 自動(作業フォルダ内の output/final.mp4)"}
          </div>
        </div>
        <div className="exportSettingsFooter">
          <button className="secondaryButton" onClick={onCancel} type="button">
            キャンセル
          </button>
          <button
            className="primaryButton"
            onClick={() =>
              onSubmit({
                directory,
                fileName: fileName ? ensureMp4FileName(fileName) : "",
                resolution,
                quality,
                renderSpeed,
                hardwareEncode,
              })
            }
            type="button"
          >
            <Download size={16} />
            <span>書き出し開始</span>
          </button>
        </div>
      </div>
    </div>
  );
}

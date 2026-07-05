import React from "react";
import { Composition, getInputProps, staticFile } from "remotion";
import { loadFont as loadZenKaku } from "@remotion/google-fonts/ZenKakuGothicAntique";
import { loadFont as loadNotoSansJP } from "@remotion/google-fonts/NotoSansJP";
import { loadFont as loadZenMaru } from "@remotion/google-fonts/ZenMaruGothic";
import { loadFont as loadNotoSerifJP } from "@remotion/google-fonts/NotoSerifJP";
import { loadFont as loadShipporiMincho } from "@remotion/google-fonts/ShipporiMincho";
// フェーズT2.5-3: 明朝(serif_quote/serif_harsh)・極太・毛筆(op_brush)フォント
import { loadFont as loadShipporiMinchoB1 } from "@remotion/google-fonts/ShipporiMinchoB1";
import { loadFont as loadDelaGothicOne } from "@remotion/google-fonts/DelaGothicOne";
import { loadFont as loadYujiSyuku } from "@remotion/google-fonts/YujiSyuku";
import { loadFont as loadBizUdpGothic } from "@remotion/google-fonts/BIZUDPGothic";
import { loadFont as loadKosugiMaru } from "@remotion/google-fonts/KosugiMaru";
import { loadFont as loadMPlusRounded } from "@remotion/google-fonts/MPLUSRounded1c";
import { loadFont as loadMochiyPopOne } from "@remotion/google-fonts/MochiyPopOne";
import { loadFont as loadRocknRollOne } from "@remotion/google-fonts/RocknRollOne";
import { loadFont as loadKleeOne } from "@remotion/google-fonts/KleeOne";
import { loadFont as loadHinaMincho } from "@remotion/google-fonts/HinaMincho";
import { loadFont as loadReggaeOne } from "@remotion/google-fonts/ReggaeOne";
import { loadFont as loadTrainOne } from "@remotion/google-fonts/TrainOne";
import { loadFont as loadDotGothic16 } from "@remotion/google-fonts/DotGothic16";
import { loadFont as loadBebasNeue } from "@remotion/google-fonts/BebasNeue";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadCaveat } from "@remotion/google-fonts/Caveat";
import { CatCutComposition } from "./compositions/CatCutComposition";

// 日本語フォントは subset 名が [0], [1]... の分割形式なので、Remotion の
// "japanese" subset 指定は使えない。必要 weight だけに絞ってロードする。
const fontOptions = { ignoreTooManyRequestsWarning: true };
loadZenKaku("normal", { ...fontOptions, weights: ["400", "700", "900"] });
loadNotoSansJP("normal", { ...fontOptions, weights: ["400", "700", "900"] });
loadZenMaru("normal", { ...fontOptions, weights: ["400", "700", "900"] });
loadNotoSerifJP("normal", { ...fontOptions, weights: ["400", "700", "900"] });
loadShipporiMincho("normal", { ...fontOptions, weights: ["400", "700", "800"] });
loadShipporiMinchoB1("normal", { ...fontOptions, weights: ["400", "700", "800"] });
loadDelaGothicOne("normal", { ...fontOptions, weights: ["400"] });
loadYujiSyuku("normal", { ...fontOptions, weights: ["400"] });
loadBizUdpGothic("normal", { ...fontOptions, weights: ["400", "700"] });
loadKosugiMaru("normal", { ...fontOptions, weights: ["400"] });
loadMPlusRounded("normal", { ...fontOptions, weights: ["400", "700", "800", "900"] });
loadMochiyPopOne("normal", { ...fontOptions, weights: ["400"] });
loadRocknRollOne("normal", { ...fontOptions, weights: ["400"] });
loadKleeOne("normal", { ...fontOptions, weights: ["400", "600"] });
loadHinaMincho("normal", { ...fontOptions, weights: ["400"] });
loadReggaeOne("normal", { ...fontOptions, weights: ["400"] });
loadTrainOne("normal", { ...fontOptions, weights: ["400"] });
loadDotGothic16("normal", { ...fontOptions, weights: ["400"] });
loadBebasNeue("normal", { ...fontOptions, weights: ["400"], subsets: ["latin"] });
loadAnton("normal", { ...fontOptions, weights: ["400"], subsets: ["latin"] });
loadCaveat("normal", { ...fontOptions, weights: ["400", "700"], subsets: ["latin"] });

interface InputProps {
  timeline?: {
    version: string;
    total_duration_ms: number;
    video_fit: string;
    fps: number;
    cuts: unknown[];
    [key: string]: unknown;
  };
  voice_data?: {
    version: string;
    cuts: unknown[];
  };
  meta?: Record<string, unknown>;
  width?: number;
  height?: number;
}

export const RemotionRoot: React.FC = () => {
  const inputProps = getInputProps() as InputProps;

  return (
    <>
      <Composition
        id="CatCut"
        component={CatCutComposition as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={900} // calculateMetadata で上書きされる
        fps={30}
        width={1280}
        height={720}
        defaultProps={{
          timeline: inputProps.timeline || {
            version: "1.0.0",
            total_duration_ms: 30000,
            video_fit: "cover",
            fps: 30,
            cuts: [],
          },
          voice_data: inputProps.voice_data || { version: "1.0", cuts: [] },
          meta: inputProps.meta || {},
        } as Record<string, unknown>}
        calculateMetadata={async ({ props }) => {
          // CLI render 時は getInputProps() で渡されるのでそのまま使う
          const ip = getInputProps() as InputProps;
          if (ip.timeline && ip.timeline.cuts && (ip.timeline.cuts as unknown[]).length > 0) {
            const meta = (ip.meta || {}) as Record<string, unknown>;
            const fps = ip.timeline.fps || 30;
            return {
              durationInFrames: Math.ceil((ip.timeline.total_duration_ms / 1000) * fps),
              fps,
              width: ip.width || (meta.display_width as number) || 1280,
              height: ip.height || (meta.display_height as number) || 720,
              props: {
                timeline: ip.timeline,
                voice_data: ip.voice_data || { version: "1.0", cuts: [] },
                meta: ip.meta || {},
              },
            };
          }

          // Studio 時: public/composition-v2.json から読み込み
          // cache-bust 付与: Studio の HMR がファイル変更を拾わないことがあるため
          try {
            const res = await fetch(`${staticFile("composition-v2.json")}?t=${Date.now()}`, { cache: "no-store" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const meta = data.meta || {};
            const fps = data.timeline?.fps || 30;
            const totalMs = data.timeline?.total_duration_ms || 30000;
            return {
              durationInFrames: Math.ceil((totalMs / 1000) * fps),
              fps,
              width: (meta.display_width as number) || 1280,
              height: (meta.display_height as number) || 720,
              props: {
                timeline: data.timeline,
                voice_data: data.voice_data || { version: "1.0", cuts: [] },
                meta,
              },
            };
          } catch {
            // composition.json がない場合はデフォルト
            return {
              durationInFrames: 900,
              fps: 30,
              width: 1280,
              height: 720,
            };
          }
        }}
      />
    </>
  );
};

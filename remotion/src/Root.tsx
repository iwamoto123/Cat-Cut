import React from "react";
import { Composition, continueRender, delayRender, getInputProps, staticFile } from "remotion";
import { CatCutComposition } from "./compositions/CatCutComposition";

// フェーズW32: 全フォントをローカル同梱(remotion/public/fonts/)からロードする。
// 従来は @remotion/google-fonts で fonts.gstatic.com から都度取得していたため、
// 回線が不安定な環境では delayRender タイムアウト → 書き出し失敗になっていた
// (2026-08-22 社員PCで発生: ERR_NETWORK_CHANGED)。レンダリングはネットワーク不要。
//
// Googleフォント(fonts/google/)は scripts/download_google_fonts.sh で取得・WOFF2圧縮した
// もの(OFL/Apacheライセンス。商用利用・同梱可)。weight未指定は400のみ。
// -Variable.ttf は可変フォントなので weight範囲 "100 900" で全ウェイトを賄う。
// その他のローカルフォント(源暎ゴシック等)の出所・ライセンスは assets/fonts/README.md 参照。
const localFonts: Array<{ family: string; url: string; weight?: string }> = [
  // Google Fontsに無い書体(従来からローカル)
  { family: "GenEi Gothic N U-KL", url: "fonts/GenEiGothicN-U-KL.otf" },
  { family: "GenEi Gothic N H-KL", url: "fonts/GenEiGothicN-H-KL.otf" },
  { family: "GenEi Kiwami Go", url: "fonts/GenEiKiwamiGo.ttf" },
  { family: "GenEi POPle Bk", url: "fonts/GenEiPOPle-Bk.ttf" },
  { family: "Keifont", url: "fonts/keifont.ttf" },
  { family: "LanobePOP", url: "fonts/LanobePOP.otf" },
  // Google Fonts(W32でローカル同梱化)
  { family: "Zen Kaku Gothic Antique", url: "fonts/google/ZenKakuGothicAntique-Regular.woff2", weight: "400" },
  { family: "Zen Kaku Gothic Antique", url: "fonts/google/ZenKakuGothicAntique-Bold.woff2", weight: "700" },
  { family: "Zen Kaku Gothic Antique", url: "fonts/google/ZenKakuGothicAntique-Black.woff2", weight: "900" },
  { family: "Noto Sans JP", url: "fonts/google/NotoSansJP-Variable.woff2", weight: "100 900" },
  { family: "Noto Serif JP", url: "fonts/google/NotoSerifJP-Variable.woff2", weight: "100 900" },
  { family: "Zen Maru Gothic", url: "fonts/google/ZenMaruGothic-Regular.woff2", weight: "400" },
  { family: "Zen Maru Gothic", url: "fonts/google/ZenMaruGothic-Bold.woff2", weight: "700" },
  { family: "Zen Maru Gothic", url: "fonts/google/ZenMaruGothic-Black.woff2", weight: "900" },
  { family: "Shippori Mincho", url: "fonts/google/ShipporiMincho-Regular.woff2", weight: "400" },
  { family: "Shippori Mincho", url: "fonts/google/ShipporiMincho-Bold.woff2", weight: "700" },
  { family: "Shippori Mincho", url: "fonts/google/ShipporiMincho-ExtraBold.woff2", weight: "800" },
  { family: "Shippori Mincho B1", url: "fonts/google/ShipporiMinchoB1-Regular.woff2", weight: "400" },
  { family: "Shippori Mincho B1", url: "fonts/google/ShipporiMinchoB1-Bold.woff2", weight: "700" },
  { family: "Shippori Mincho B1", url: "fonts/google/ShipporiMinchoB1-ExtraBold.woff2", weight: "800" },
  { family: "Dela Gothic One", url: "fonts/google/DelaGothicOne-Regular.woff2" },
  { family: "Yuji Syuku", url: "fonts/google/YujiSyuku-Regular.woff2" },
  { family: "BIZ UDPGothic", url: "fonts/google/BIZUDPGothic-Regular.woff2", weight: "400" },
  { family: "BIZ UDPGothic", url: "fonts/google/BIZUDPGothic-Bold.woff2", weight: "700" },
  { family: "Kosugi Maru", url: "fonts/google/KosugiMaru-Regular.woff2" },
  { family: "M PLUS Rounded 1c", url: "fonts/google/MPLUSRounded1c-Regular.woff2", weight: "400" },
  { family: "M PLUS Rounded 1c", url: "fonts/google/MPLUSRounded1c-Bold.woff2", weight: "700" },
  { family: "M PLUS Rounded 1c", url: "fonts/google/MPLUSRounded1c-ExtraBold.woff2", weight: "800" },
  { family: "M PLUS Rounded 1c", url: "fonts/google/MPLUSRounded1c-Black.woff2", weight: "900" },
  { family: "Mochiy Pop One", url: "fonts/google/MochiyPopOne-Regular.woff2" },
  { family: "RocknRoll One", url: "fonts/google/RocknRollOne-Regular.woff2" },
  { family: "Klee One", url: "fonts/google/KleeOne-Regular.woff2", weight: "400" },
  { family: "Klee One", url: "fonts/google/KleeOne-SemiBold.woff2", weight: "600" },
  { family: "Hina Mincho", url: "fonts/google/HinaMincho-Regular.woff2" },
  { family: "Reggae One", url: "fonts/google/ReggaeOne-Regular.woff2" },
  { family: "Train One", url: "fonts/google/TrainOne-Regular.woff2" },
  { family: "DotGothic16", url: "fonts/google/DotGothic16-Regular.woff2" },
  { family: "Bebas Neue", url: "fonts/google/BebasNeue-Regular.woff2" },
  { family: "Anton", url: "fonts/google/Anton-Regular.woff2" },
  { family: "Caveat", url: "fonts/google/Caveat-Variable.woff2", weight: "100 900" },
];
// W32: 全40ファイル(約100MB)を毎タブで一斉ロードするとフォント取得が詰まって
// delayRender タイムアウトすることがあるため、レンダリング時は「コンポーネントに
// ハードコードされたコア書体 + コンポジションJSONに登場する書体」だけをロードする。
// Studio(inputPropsなし)ではフォント切替を試せるよう全書体をロードする。
const CORE_FONT_FAMILIES = new Set([
  "Zen Kaku Gothic Antique", // Telop.tsx / overlayStyles.ts の既定スタック
  "Dela Gothic One", // OpSequence.tsx
  "GenEi Gothic N U-KL", // OpSequence.tsx
]);
const inputPropsForFonts = getInputProps() as Record<string, unknown>;
const isRenderMode = Boolean(inputPropsForFonts && inputPropsForFonts.timeline);
const propsJsonForFonts = isRenderMode ? JSON.stringify(inputPropsForFonts) : "";
const fontsToLoad = isRenderMode
  ? localFonts.filter(
      ({ family }) => CORE_FONT_FAMILIES.has(family) || propsJsonForFonts.includes(family)
    )
  : localFonts;

// W32: フォント読込でレンダリングを絶対に落とさない。
// - @remotion/fonts の loadFont(FontFaceにURL方式)は、フェッチが固まると
//   delayRenderタイムアウトで書き出し全体が失敗する(2026-08-22 社員PCで発生)。
// - ここでは fetch(no-store・タイムアウト付き)→ArrayBuffer→FontFace 方式でリトライし、
//   ハードデッドライン(30秒)で必ず continueRender する。読めなかった書体は
//   フォールバックフォントで表示され、書き出し自体は完走する。
const FONT_FETCH_TIMEOUT_MS = 5000;
const FONT_FETCH_RETRIES = 2;
const FONT_HARD_DEADLINE_MS = 12000;
async function fetchAndAddFont(family: string, url: string, weight?: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= FONT_FETCH_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FONT_FETCH_TIMEOUT_MS);
      let buffer: ArrayBuffer;
      try {
        // no-store: 複数タブが同一URLを同時取得した際のHTTPキャッシュロック競合を避ける
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffer = await res.arrayBuffer();
      } finally {
        clearTimeout(timer);
      }
      const font = new FontFace(family, buffer, weight ? { weight } : {});
      await font.load();
      document.fonts.add(font);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
function loadFontRobust(family: string, url: string, weight?: string): void {
  const handle = delayRender(`Loading font ${family} (${url})`, {
    // 通常はハードデッドラインでこちらから continueRender する。
    // ページ生成直後のフェッチが固まった場合(チャンク境界のページ差し替えで観測)は
    // このタイムアウトがNode側で発火するが、retries を指定しているため Remotion が
    // ページを作り直してフレームを再試行する(retriesなしだと書き出し全体が即失敗する)。
    timeoutInMilliseconds: FONT_HARD_DEADLINE_MS + 8000,
    retries: 4,
  });
  let done = false;
  const finish = (error?: unknown) => {
    if (done) return;
    done = true;
    if (error) {
      console.error(`[fonts] ${family} の読み込みに失敗。フォールバックで続行:`, error);
    }
    continueRender(handle);
  };
  const deadline = setTimeout(
    () => finish(new Error(`hard deadline ${FONT_HARD_DEADLINE_MS}ms exceeded`)),
    FONT_HARD_DEADLINE_MS
  );
  fetchAndAddFont(family, url, weight)
    .then(() => {
      clearTimeout(deadline);
      finish();
    })
    .catch((error) => {
      clearTimeout(deadline);
      finish(error);
    });
}
// モジュール評価中(ページ準備中)の fetch はリクエストインターセプション等と競合して
// 固まることがあるため、ページの load 完了後に開始する
const startFontLoading = () => {
  fontsToLoad.forEach(({ family, url, weight }) => {
    loadFontRobust(family, staticFile(url), weight);
  });
};
if (typeof document !== "undefined" && document.readyState === "complete") {
  startFontLoading();
} else if (typeof window !== "undefined") {
  window.addEventListener("load", startFontLoading, { once: true });
} else {
  startFontLoading();
}

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

/**
 * フェーズW2: シーン映像ギミック(timeline.video_effects)の正規化とスタイル計算(純関数)。
 *
 * step08(python shared/video_effects.py)が決定的に選定した効果を、
 * Remotion本編(CatCutComposition)とdesktopプレビュー(PreviewPlayer)が
 * この同じ関数で transform/filter に変換する=プレビューと書き出しの見た目一致。
 *
 * - pinch: 画面が少し縮小(scale 0.9)+暗転(brightness 0.6)+周囲は黒。
 *   出入り各150msのease(smoothstep)。開始時に teen SFX(音量0.3・描画側が再生)。
 * - zoom: focus(画面比率0〜1の注視点)を原点に 1.0→scale(既定1.25)を
 *   500msのease-outでズームイン、区間中維持、終了フレームで即座に戻す。
 *
 * フェーズW24 Phase C(ビジネス広告向け)で3種追加:
 * - dim: 映像を暗くして(黒オーバーレイ相当の brightness 低下。既定は50%)テロップを
 *   際立たせる。出入り各300msのease(smoothstep)。transformは変えない。
 * - face_zoom: focus(顔中心。顔なしは中央上寄り)を原点に、区間全長かけて
 *   1.0→scale(既定1.15)へease-in-outでゆっくり寄る。
 * - slow_push: 画面中央を原点に、区間(カット)全長かけて 1.0→scale(既定1.06)へ
 *   線形で寄せ続ける(単調回避の常用モーション)。
 *
 * focus は顔検出・手動調整で書き換えるだけでよく、この計算は不変で動く。
 */

/** pinch の出入りease長(ms)。カット感を残しつつ急峻すぎない値。 */
export const PINCH_EDGE_MS = 150;

/** zoom のズームイン所要時間(ms)。ease-outで到達後は区間終端まで維持する。 */
export const ZOOM_EASE_MS = 500;

/** dim の出入りease長(ms)。pinchより穏やかにフェードさせる。 */
export const DIM_EDGE_MS = 300;

/** pinch開始で鳴らす teen SFX の音量(通常テロップSFXの既定0.25より少し控えめな「小さく鳴る」)。 */
export const VIDEO_EFFECT_SFX_VOLUME = 0.3;

/** パラメータ省略時の既定値(python shared/video_effects.py の定数と同期)。 */
export const DEFAULT_PINCH_SCALE = 0.9;
export const DEFAULT_PINCH_BRIGHTNESS = 0.6;
export const DEFAULT_ZOOM_SCALE = 1.25;
export const DEFAULT_ZOOM_FOCUS = { x: 0.5, y: 0.35 } as const;
/** dim の暗さ(黒オーバーレイ換算の不透明度)。0.5=50%暗くする。 */
export const DEFAULT_DIM_OPACITY = 0.5;
export const DEFAULT_FACE_ZOOM_SCALE = 1.15;
/** face_zoom で顔が検出できなかったときの注視点(中央上寄り=人物の顔が来やすい位置)。 */
export const FACE_ZOOM_FALLBACK_FOCUS = { x: 0.5, y: 0.35 } as const;
export const DEFAULT_SLOW_PUSH_SCALE = 1.06;

export type VideoEffectType = "pinch" | "zoom" | "dim" | "face_zoom" | "slow_push";

const VIDEO_EFFECT_TYPES: readonly string[] = ["pinch", "zoom", "dim", "face_zoom", "slow_push"];

export type VideoEffect = {
  id: string;
  type: VideoEffectType;
  /** タイムラインms(OPオフセット済み)。 */
  start_ms: number;
  end_ms: number;
  /** 選定元スロット(表示には使わない。検品・デバッグ用)。 */
  slot_id: string;
  params: {
    scale: number;
    /** pinch のみ。 */
    brightness?: number;
    /** zoom / face_zoom のみ。画面比率0〜1の注視点。 */
    focus?: { x: number; y: number };
    /** dim のみ。黒オーバーレイ換算の不透明度(0〜1)。 */
    opacity?: number;
  };
  /** pinch のみ。開始時に鳴らすSFX ID(teen)。 */
  sfx?: string;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * timeline.video_effects(未検証JSON)を正規化する。
 * 不正エントリは捨て、パラメータは既定値で補完+安全な範囲へクランプする。
 * video_effects の無い既存compositionは空配列=描画なし(完全後方互換)。
 */
export function normalizeVideoEffects(raw: unknown): VideoEffect[] {
  if (!Array.isArray(raw)) return [];
  const effects: VideoEffect[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const type = entry.type;
    if (typeof type !== "string" || !VIDEO_EFFECT_TYPES.includes(type)) continue;
    const effectType = type as VideoEffectType;
    const startMs = Math.round(Number(entry.start_ms));
    const endMs = Math.round(Number(entry.end_ms));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const params = (entry.params && typeof entry.params === "object" ? entry.params : {}) as Record<
      string,
      unknown
    >;
    const effect: VideoEffect = {
      id: String(entry.id ?? `ve_${effects.length + 1}`),
      type: effectType,
      start_ms: startMs,
      end_ms: endMs,
      slot_id: String(entry.slot_id ?? ""),
      params: { scale: 1 },
    };
    const scale = Number(params.scale);
    const readFocus = (fallback: { x: number; y: number }): { x: number; y: number } => {
      const focus = (params.focus && typeof params.focus === "object" ? params.focus : {}) as Record<
        string,
        unknown
      >;
      const focusX = Number(focus.x);
      const focusY = Number(focus.y);
      return {
        x: Number.isFinite(focusX) ? clamp01(focusX) : fallback.x,
        y: Number.isFinite(focusY) ? clamp01(focusY) : fallback.y,
      };
    };
    if (effectType === "pinch") {
      // 縮小効果なので 0.5〜1.0 に制限(1超の指定はズームと紛らわしいため既定へ)
      effect.params.scale =
        Number.isFinite(scale) && scale >= 0.5 && scale <= 1.0 ? scale : DEFAULT_PINCH_SCALE;
      const brightness = Number(params.brightness);
      effect.params.brightness =
        Number.isFinite(brightness) && brightness >= 0 && brightness <= 1
          ? brightness
          : DEFAULT_PINCH_BRIGHTNESS;
      const sfx = entry.sfx;
      if (typeof sfx === "string" && sfx) effect.sfx = sfx;
    } else if (effectType === "zoom") {
      // 拡大効果なので 1.0〜2.0 に制限
      effect.params.scale =
        Number.isFinite(scale) && scale >= 1.0 && scale <= 2.0 ? scale : DEFAULT_ZOOM_SCALE;
      effect.params.focus = readFocus(DEFAULT_ZOOM_FOCUS);
    } else if (effectType === "dim") {
      // 暗転強調: scaleは使わない(1固定)。opacityは0〜0.7(それ以上は業務用途で暗すぎる)
      const opacity = Number(params.opacity);
      effect.params.opacity =
        Number.isFinite(opacity) && opacity > 0 && opacity <= 0.7 ? opacity : DEFAULT_DIM_OPACITY;
    } else if (effectType === "face_zoom") {
      // ゆっくり寄るだけなので控えめな 1.0〜1.5 に制限
      effect.params.scale =
        Number.isFinite(scale) && scale >= 1.0 && scale <= 1.5 ? scale : DEFAULT_FACE_ZOOM_SCALE;
      effect.params.focus = readFocus(FACE_ZOOM_FALLBACK_FOCUS);
    } else {
      // slow_push: ごくゆっくりの常用モーションなので 1.0〜1.2 に制限
      effect.params.scale =
        Number.isFinite(scale) && scale >= 1.0 && scale <= 1.2 ? scale : DEFAULT_SLOW_PUSH_SCALE;
    }
    effects.push(effect);
  }
  effects.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  return effects;
}

/** タイムラインms時点で表示中の効果(開始昇順の最初の1件。設計上は重ならない)。 */
export function activeVideoEffectAt(effects: readonly VideoEffect[], tMs: number): VideoEffect | null {
  for (const effect of effects) {
    if (effect.start_ms <= tMs && tMs < effect.end_ms) return effect;
  }
  return null;
}

/** smoothstep(3u^2-2u^3)。pinch の出入りease用。 */
function easeInOut01(u: number): number {
  const t = clamp01(u);
  return t * t * (3 - 2 * t);
}

/** ease-out cubic。zoom のズームイン用(最初速く、到達に向けて減速)。 */
function easeOut01(u: number): number {
  const t = clamp01(u);
  return 1 - Math.pow(1 - t, 3);
}

export type VideoEffectStyle = {
  transform: string;
  transformOrigin: string;
  filter?: string;
};

/**
 * タイムラインms時点の効果スタイルを計算する(純関数・決定的)。
 * 区間外は null(=スタイル適用なし)。呼び出し側は映像のwrapper要素へ
 * transform / transformOrigin / filter をそのまま適用する
 * (グローバルframingは内側の要素に残す=ネストで乗算合成)。
 */
export function videoEffectStyle(effect: VideoEffect, tMs: number): VideoEffectStyle | null {
  if (tMs < effect.start_ms || tMs >= effect.end_ms) return null;

  if (effect.type === "pinch") {
    // 出入り各150ms(区間が短い場合は半分ずつ)でease。定常部は scale/brightness を維持する
    const edgeMs = Math.min(PINCH_EDGE_MS, (effect.end_ms - effect.start_ms) / 2);
    const progress =
      edgeMs > 0
        ? easeInOut01(Math.min((tMs - effect.start_ms) / edgeMs, (effect.end_ms - tMs) / edgeMs))
        : 1;
    const scale = 1 + (effect.params.scale - 1) * progress;
    const brightness = 1 + ((effect.params.brightness ?? DEFAULT_PINCH_BRIGHTNESS) - 1) * progress;
    return {
      transform: `scale(${scale})`,
      transformOrigin: "center center",
      filter: `brightness(${brightness})`,
    };
  }

  if (effect.type === "dim") {
    // 暗転強調: 出入り各300ms(区間が短い場合は半分ずつ)でease。黒オーバーレイと同値の
    // brightness低下で映像だけ暗くする(テロップは別レイヤーなのでそのまま際立つ)
    const edgeMs = Math.min(DIM_EDGE_MS, (effect.end_ms - effect.start_ms) / 2);
    const progress =
      edgeMs > 0
        ? easeInOut01(Math.min((tMs - effect.start_ms) / edgeMs, (effect.end_ms - tMs) / edgeMs))
        : 1;
    const opacity = (effect.params.opacity ?? DEFAULT_DIM_OPACITY) * progress;
    return {
      transform: "none",
      transformOrigin: "center center",
      filter: `brightness(${1 - opacity})`,
    };
  }

  if (effect.type === "face_zoom") {
    // 顔ズーム: focus(顔中心)原点で区間全長かけて 1.0→scale へease-in-outでゆっくり寄る
    const focus = effect.params.focus ?? FACE_ZOOM_FALLBACK_FOCUS;
    const progress = easeInOut01((tMs - effect.start_ms) / (effect.end_ms - effect.start_ms));
    const scale = 1 + (effect.params.scale - 1) * progress;
    return {
      transform: `scale(${scale})`,
      transformOrigin: `${focus.x * 100}% ${focus.y * 100}%`,
    };
  }

  if (effect.type === "slow_push") {
    // ゆっくり寄り: 画面中央原点で区間(カット)全長かけて 1.0→scale へ線形に寄せ続ける
    const progress = clamp01((tMs - effect.start_ms) / (effect.end_ms - effect.start_ms));
    const scale = 1 + (effect.params.scale - 1) * progress;
    return {
      transform: `scale(${scale})`,
      transformOrigin: "center center",
    };
  }

  // zoom: focus原点で 1.0→scale をease-out。到達後は区間終端まで維持(終端で即座に戻す)
  const focus = effect.params.focus ?? DEFAULT_ZOOM_FOCUS;
  const progress = easeOut01((tMs - effect.start_ms) / ZOOM_EASE_MS);
  const scale = 1 + (effect.params.scale - 1) * progress;
  return {
    transform: `scale(${scale})`,
    transformOrigin: `${focus.x * 100}% ${focus.y * 100}%`,
  };
}

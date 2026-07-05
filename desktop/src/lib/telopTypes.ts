/**
 * フェーズT2.5-4: シーン種類(semantic type)ベースのプリセット体系(UI側)。
 *
 * AIパス3(step06c)はシーンの「意味種類」(10種)を返し、type → preset の
 * マッピング(既定 + ユーザー設定)でスタイルを解決する。ユーザーマッピングは
 * main側の userData(telop_type_mapping.json)に永続化され、変更すると
 * step08 再実行時・UI適用時に全シーンへ再解決される。
 *
 * python/shared/telop_types.py と type一覧・既定マッピングを同期すること。
 */

/** シーンの意味種類(semantic type)。表示順もこの配列順。 */
export const SEMANTIC_TYPES = [
  "default",
  "surprise",
  "harsh",
  "quote",
  "emphasis",
  "question",
  "reply",
  "punchline",
  "hype",
  "cta",
] as const;

export type SemanticType = (typeof SEMANTIC_TYPES)[number];

export const DEFAULT_SEMANTIC_TYPE: SemanticType = "default";

/** typeバッジ・設定ビューに表示する日本語名と説明。 */
export const SEMANTIC_TYPE_INFO: Record<SemanticType, { label: string; description: string }> = {
  default: { label: "説明", description: "説明・事実・データの提示" },
  surprise: { label: "意外な事実", description: "「実は〜」のような驚きの新情報" },
  harsh: { label: "辛辣", description: "辛辣・毒舌・厳しい指摘" },
  quote: { label: "名言", description: "名言・格言・心に残る言い切り" },
  emphasis: { label: "強調", description: "強調・断言・危機感" },
  question: { label: "質問", description: "聞き手の質問・ツッコミ" },
  reply: { label: "相槌", description: "相槌・軽い返し・同意" },
  punchline: { label: "オチ", description: "話の要点・結論・オチ" },
  hype: { label: "煽り", description: "強い煽り・特別感の演出" },
  cta: { label: "CTA", description: "行動喚起(登録・申込など)" },
};

/**
 * フェーズT3: マッピング1エントリ。旧形式(文字列=styleのみ)から
 * { style, animation_in?, sfx? } へ拡張(保存も新形式で行う。旧形式も読める)。
 */
export type TelopTypeMappingEntry = {
  style: string;
  /** 種類ごとの既定登場アニメ(未指定=プリセット既定に任せる)。 */
  animation_in?: string;
  /** 種類ごとの既定効果音ID(未指定=プリセット既定。"none"=鳴らさない明示)。 */
  sfx?: string;
};

export type TelopTypeMapping = Record<SemanticType, TelopTypeMappingEntry>;

/** templates/telop_type_mapping.yaml と同内容の既定マッピング(main未接続時のフォールバック)。 */
export const DEFAULT_TYPE_MAPPING: TelopTypeMapping = {
  default: { style: "fact_yellow" },
  surprise: { style: "box_yellow" },
  harsh: { style: "serif_harsh" },
  quote: { style: "serif_quote" },
  emphasis: { style: "emotion_red" },
  question: { style: "question_blue" },
  reply: { style: "reply_cyan" },
  punchline: { style: "box_yellow" },
  hype: { style: "special_purple" },
  cta: { style: "cta_yellow" },
};

/** 未知・欠落のtypeを10種へ正規化する(pythonの sanitize_semantic_type と同じ規則)。 */
export function sanitizeSemanticType(value: unknown): SemanticType {
  if (typeof value === "string" && (SEMANTIC_TYPES as readonly string[]).includes(value)) {
    return value as SemanticType;
  }
  return DEFAULT_SEMANTIC_TYPE;
}

export function isSemanticType(value: unknown): value is SemanticType {
  return typeof value === "string" && (SEMANTIC_TYPES as readonly string[]).includes(value);
}

/** typeバッジの日本語ラベル。 */
export function semanticTypeLabel(type: string | null | undefined): string {
  return SEMANTIC_TYPE_INFO[sanitizeSemanticType(type)].label;
}

/**
 * マッピング1エントリの正規化(フェーズT3: 新旧形式対応)。
 * 旧形式の文字列は { style } へ包む。無効なら null。
 */
export function sanitizeMappingEntry(value: unknown): Partial<TelopTypeMappingEntry> | null {
  if (typeof value === "string") {
    return value.trim() ? { style: value.trim() } : null;
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const entry: Partial<TelopTypeMappingEntry> = {};
    if (typeof source.style === "string" && source.style.trim()) entry.style = source.style.trim();
    if (typeof source.animation_in === "string" && source.animation_in.trim()) {
      entry.animation_in = source.animation_in.trim();
    }
    if (typeof source.sfx === "string" && source.sfx.trim()) entry.sfx = source.sfx.trim();
    return Object.keys(entry).length ? entry : null;
  }
  return null;
}

/**
 * main(userData)から受け取った生マッピングを、全typeのエントリを持つ完全な
 * マッピングへ正規化する(欠落・不正値は既定マッピングで補完)。
 * フェーズT3: 値は旧形式(文字列)と新形式({ style, animation_in?, sfx? })の両方を読める。
 */
export function sanitizeTypeMapping(raw: unknown): TelopTypeMapping {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mapping = {} as TelopTypeMapping;
  for (const type of SEMANTIC_TYPES) {
    const entry = sanitizeMappingEntry(source[type]);
    mapping[type] = { ...DEFAULT_TYPE_MAPPING[type], ...(entry ?? {}) };
  }
  return mapping;
}

/** type → プリセットIDを解決する(マッピング未指定・欠落は既定マッピング)。 */
export function resolveStyleForType(
  type: string | null | undefined,
  mapping?: Partial<Record<SemanticType, TelopTypeMappingEntry | string>> | null,
): string {
  const normalized = sanitizeSemanticType(type);
  const entry = sanitizeMappingEntry(mapping?.[normalized]);
  return entry?.style || DEFAULT_TYPE_MAPPING[normalized].style;
}

/**
 * フェーズT3: type → マッピングの既定登場アニメを解決する
 * (未指定は null = プリセット既定に任せる)。
 */
export function resolveAnimationForType(
  type: string | null | undefined,
  mapping?: Partial<Record<SemanticType, TelopTypeMappingEntry | string>> | null,
): string | null {
  const normalized = sanitizeSemanticType(type);
  const entry = sanitizeMappingEntry(mapping?.[normalized]);
  return entry?.animation_in || DEFAULT_TYPE_MAPPING[normalized].animation_in || null;
}

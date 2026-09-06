// W12-2: プラン表示定義(desktop側)。
//
// id は billing/config/plans.json と一致させること(購入ボタン→ /checkout {plan} に渡す)。
// 金額はStripe側のPriceが正のためここには持たず、金額決定までは「準備中」を表示する。
export type BillingPlanDisplay = {
  id: string;
  label: string;
  kind: "subscription" | "one_time";
  /** 表示用の価格文言。金額決定後に「¥980/月」等へ更新する。 */
  priceLabel: string;
  description: string;
};

export const BILLING_PLANS: BillingPlanDisplay[] = [
  {
    id: "monthly",
    label: "月額プラン",
    kind: "subscription",
    priceLabel: "準備中",
    description: "毎月のお支払い。いつでも解約できます",
  },
  {
    id: "yearly",
    label: "年額プラン",
    kind: "subscription",
    priceLabel: "準備中",
    description: "年1回のお支払い",
  },
  {
    id: "lifetime",
    label: "買い切りプラン",
    kind: "one_time",
    priceLabel: "準備中",
    description: "1回のお支払いでずっと使えます",
  },
];

// W12-1: ライセンス保存の抽象レイヤー。
//
// サーバ本体は get/put/findBySessionId/findBySubscriptionId だけに依存する。
// 現在の実装は data/licenses.json への単純JSONファイル永続化(小規模想定)。
// 将来件数が増えたら createStore の中身だけ SQLite 等へ差し替える。
//
// レコード形状:
// {
//   licenseId, plan, kind, issuedAt, stripeCustomerId, stripeSubscriptionId?,
//   key,                       // 署名済みライセンスキー全文
//   status: "active"|"past_due"|"revoked",
//   stripeCheckoutSessionId,   // 発行元のCheckoutセッション(claim用)
//   deviceIds: string[],       // activateしてきた端末ID
//   updatedAt
// }
import fs from "node:fs";
import path from "node:path";

/**
 * JSONファイルベースのライセンスストアを作る。
 * 書き込みは tmpファイル→rename のアトミック方式(書き込み途中のクラッシュで
 * licenses.json が壊れるのを防ぐ)。
 */
export function createStore(filePath) {
  function readAll() {
    if (!fs.existsSync(filePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // 壊れたファイルは読み飛ばす(上書き保存で復旧する)
      return {};
    }
  }

  function writeAll(licenses) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(licenses, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  return {
    /** licenseId でレコードを取得する。無ければ null。 */
    get(licenseId) {
      return readAll()[String(licenseId || "")] || null;
    },

    /** レコードを保存する(licenseId をキーに upsert)。 */
    put(license) {
      if (!license || typeof license.licenseId !== "string" || !license.licenseId) {
        throw new Error("licenseId のないレコードは保存できません");
      }
      const all = readAll();
      all[license.licenseId] = { ...license, updatedAt: new Date().toISOString() };
      writeAll(all);
      return all[license.licenseId];
    },

    /** Checkoutセッション ID からレコードを引く(claimページ・webhook冪等化用)。 */
    findBySessionId(sessionId) {
      const target = String(sessionId || "");
      if (!target) return null;
      for (const license of Object.values(readAll())) {
        if (license.stripeCheckoutSessionId === target) return license;
      }
      return null;
    },

    /** Stripeサブスクリプション ID からレコードを引く(解約・支払い失敗webhook用)。 */
    findBySubscriptionId(subscriptionId) {
      const target = String(subscriptionId || "");
      if (!target) return null;
      for (const license of Object.values(readAll())) {
        if (license.stripeSubscriptionId === target) return license;
      }
      return null;
    },

    /**
     * W12-4: 任意フィールドの一致でレコードを引く汎用検索。
     * UnivaPay の課金ID(univapayChargeId)・定期課金ID(univapaySubscriptionId)・
     * 注文ID(univapayOrderId)での冪等化・claim検索に使う。
     */
    findByField(field, value) {
      const target = String(value || "");
      if (!field || !target) return null;
      for (const license of Object.values(readAll())) {
        if (license[field] === target) return license;
      }
      return null;
    },
  };
}

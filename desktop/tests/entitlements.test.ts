// W12-2: 機能ゲート(entitlements)の規約テスト。
// 制限ポリシーは金額決定時に確定するため、現時点では「全ステータスで全機能true」を
// 規約としてテストで固定する。ポリシー決定後はこのテストを新しい規約に書き換える。
import test from "node:test";
import assert from "node:assert/strict";
import { canExport, canUseAiFeatures, canUseApp } from "../src/lib/entitlements.ts";
import type { LicenseStatus } from "../src/lib/license.ts";

const ALL_STATUSES: LicenseStatus[] = ["unlicensed", "active", "grace", "expired"];

test("現時点の規約: どのライセンス状態でも全機能が使える(制限ポリシー未定)", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(canUseApp(status), true, `canUseApp(${status})`);
    assert.equal(canExport(status), true, `canExport(${status})`);
    assert.equal(canUseAiFeatures(status), true, `canUseAiFeatures(${status})`);
  }
});

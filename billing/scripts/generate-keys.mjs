#!/usr/bin/env node
// W12-1: ライセンス署名用の Ed25519 鍵ペアを生成する。
//
// 使い方: node scripts/generate-keys.mjs
// 出力された秘密鍵を billing/.env へ、公開鍵を desktop 側の定数
// (main/license.cjs と src/lib/license.ts の LICENSE_PUBLIC_KEY)へ貼り付ける。
// 秘密鍵は絶対にコミット・共有しないこと。
import { generateKeyPair } from "../src/licenseKeys.mjs";

const { privateKey, publicKey } = generateKeyPair();

console.log("=== Cat-Cut ライセンス署名鍵(Ed25519) ===");
console.log("");
console.log("[1] billing/.env に追記(秘密鍵。コミット厳禁):");
console.log("");
console.log(`LICENSE_SIGNING_KEY=${privateKey}`);
console.log("");
console.log("[2] desktop/main/license.cjs と desktop/src/lib/license.ts の");
console.log("    LICENSE_PUBLIC_KEY 定数に貼り付け(公開鍵。コミットしてよい):");
console.log("");
console.log(`const LICENSE_PUBLIC_KEY = "${publicKey}";`);
console.log("");
console.log("※ 鍵を作り直すと既存の発行済みライセンスは全て検証不能になります。");

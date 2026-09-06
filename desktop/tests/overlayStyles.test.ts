import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAPTER_TITLE_DEFAULTS,
  chapterTitleTextSpec,
  CTA_BANNER_BOTTOM_PX,
  overlayPositionStyle,
  PROFILE_CARD_BOTTOM_PX,
  resolveOverlayTextStyle,
} from "../src/lib/overlayStyles.ts";

/**
 * U1-5(オーバーレイのDOM版): 見た目の数値・配色・フォント定義(overlayStyles)のテスト。
 * Remotionとのファイル一致は sharedRemotionCopies.test.ts が担保する。
 * ここではPreviewOverlays.tsxが使う代表経路(配置スケール・style参照解決)を検証する。
 */

test("overlayPositionStyle: scaleに応じた配置(1080p基準デザイン値×スケール)", () => {
  // 1080p等倍
  assert.deepEqual(overlayPositionStyle("top_left", 1), {
    position: "absolute",
    display: "flex",
    top: 28,
    left: 36,
  });
  // 720p表示(scale=720/1080)では2/3
  const scaled = overlayPositionStyle("bottom_left", 720 / 1080);
  assert.equal(scaled.bottom, 44 * (720 / 1080));
  assert.equal(scaled.left, 44 * (720 / 1080));
});

test("overlayPositionStyle: profile_cardはテロップ帯を避けて下端を引き上げる(V8-3)", () => {
  // profile_card は bottom_left でもテロップ帯(telop_y=0.85付近)より上に置く
  const card = overlayPositionStyle("bottom_left", 1, "profile_card");
  assert.equal(card.bottom, PROFILE_CARD_BOTTOM_PX);
  assert.equal(card.left, 44);
  // 他typeやtype省略(旧呼び出し)は従来の44pxのまま(後方互換)
  assert.equal(overlayPositionStyle("bottom_left", 1, "chapter_title").bottom, 44);
  assert.equal(overlayPositionStyle("bottom_left", 1).bottom, 44);
  // スケール追従
  const scaledCard = overlayPositionStyle("bottom_left", 720 / 1080, "profile_card");
  assert.equal(scaledCard.bottom, PROFILE_CARD_BOTTOM_PX * (720 / 1080));
});

test("overlayPositionStyle: cta_bannerはテロップ帯を避けて下端を引き上げる(W3)", () => {
  // CTAテロップ(帯上端820px付近)と黄色ボックスが2枚重なる「バナー2重」FB対応
  const banner = overlayPositionStyle("bottom", 1, "cta_banner");
  assert.equal(banner.bottom, CTA_BANNER_BOTTOM_PX);
  // caption等の他typeやtype省略(旧呼び出し)は従来の52pxのまま(後方互換)
  assert.equal(overlayPositionStyle("bottom", 1, "caption").bottom, 52);
  assert.equal(overlayPositionStyle("bottom", 1).bottom, 52);
  // スケール追従
  const scaledBanner = overlayPositionStyle("bottom", 720 / 1080, "cta_banner");
  assert.equal(scaledBanner.bottom, CTA_BANNER_BOTTOM_PX * (720 / 1080));
});

test("resolveOverlayTextStyle: style参照(preset)があれば色・フォントを上書き、無ければ既定", () => {
  const styles = {
    my_preset: {
      font_family: "TestFont",
      fill: { type: "solid" as const, color: "#123456" },
      outer_stroke: { color: "#654321", width: 4 },
    },
  };
  const resolved = resolveOverlayTextStyle({ style: "my_preset" }, styles, CHAPTER_TITLE_DEFAULTS);
  assert.deepEqual(resolved, {
    fontFamily: "TestFont",
    fillColor: "#123456",
    strokeColor: "#654321",
  });
  // style未指定・未解決は既定のまま
  assert.deepEqual(resolveOverlayTextStyle({}, styles, CHAPTER_TITLE_DEFAULTS), CHAPTER_TITLE_DEFAULTS);
  const spec = chapterTitleTextSpec(1, CHAPTER_TITLE_DEFAULTS);
  assert.equal(spec.fontSize, 46);
  assert.equal(spec.strokeWidth, 9);
});

import React from "react";

/**
 * ブランドマーク: 耳+ヒゲだけで構成したミニマルな猫のラインアイコン。
 * ヘッダーやオンボーディングに「さりげない猫要素」として置く共通部品。
 */
export function CatMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* 耳2つ+頭の輪郭をひと筆書き風に */}
      <path d="M4.5 10.5 5 5.5l4 2.3a7.6 7.6 0 0 1 6 0l4-2.3.5 5a7.5 7.5 0 0 1 .5 3c0 4.2-3.8 7-8 7s-8-2.8-8-7c0-1.05.18-2.06.5-3z" />
      {/* ヒゲ */}
      <path d="M9.2 14.6h-2" />
      <path d="M16.8 14.6h-2" />
    </svg>
  );
}

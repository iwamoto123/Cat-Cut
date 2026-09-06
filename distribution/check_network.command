#!/bin/bash
# Cat-Cut: ElevenLabs API への接続確認（社員トラブルシュート用）
# 使い方: 右クリック →「開く」

set -u

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok() { printf '\033[32m✓ %s\033[0m\n' "$1"; }
ng() { printf '\033[31m✗ %s\033[0m\n' "$1"; }

bold "=== Cat-Cut ネットワーク診断 ==="
echo ""

bold "[1/3] api.elevenlabs.io の名前解決"
if host api.elevenlabs.io >/dev/null 2>&1; then
  host api.elevenlabs.io | head -3
  ok "DNS OK"
else
  ng "DNS で名前解決できません"
fi
echo ""

bold "[2/3] HTTPS 接続（IPv4優先）"
HTTP_CODE=$(curl -4 -sS -o /tmp/catcut_net_test_body.txt -w "%{http_code}" \
  -H "xi-api-key: test" "https://api.elevenlabs.io/v1/models" 2>/tmp/catcut_net_test_err.txt || true)
if [ "$HTTP_CODE" = "401" ]; then
  ok "ElevenLabs API へ到達できました（401=キー未設定だが通信は成功）"
elif [ "$HTTP_CODE" = "200" ]; then
  ok "ElevenLabs API へ到達できました"
else
  ng "接続失敗 HTTP=${HTTP_CODE:-none}"
  if [ -s /tmp/catcut_net_test_err.txt ]; then
    echo "--- curl エラー ---"
    cat /tmp/catcut_net_test_err.txt
  fi
fi
echo ""

bold "[3/3] Python venv（Cat-Cut本体）"
if [ -x "$HOME/CatCut/.venv/bin/python" ]; then
  ok "$HOME/CatCut/.venv/bin/python"
else
  ng "~/CatCut/.venv が見つかりません。install.command を先に実行してください"
fi
echo ""

bold "診断完了"
echo "401 以外で失敗する場合: VPN/会社Wi-Fi/ファイアウォールで api.elevenlabs.io がブロックされている可能性があります。"
echo "スマホのテザリングなど別ネットワークで再試行してください。"
read -r -p "Enterで閉じます..."

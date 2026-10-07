#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
mkdir -p "$ROOT/logs"

if ! curl -fsS http://127.0.0.1:4321/api/v1/health >/dev/null 2>&1; then
  nohup node "$ROOT/vendor/cezar/packages/cezar/dist/index.js" \
    --repo "$ROOT" --port 4321 --no-open >"$ROOT/logs/cezar.log" 2>&1 &
  echo "Started Cezar on http://127.0.0.1:4321"
fi

if ! curl -fsS http://127.0.0.1:4322/api/wechat/status >/dev/null 2>&1; then
  nohup node "$ROOT/gateway/wechat-control.mjs" >"$ROOT/logs/wechat-control.log" 2>&1 &
  echo "Started WeChat control on http://127.0.0.1:4322"
fi

if ! curl -fsS http://127.0.0.1:4324/health >/dev/null 2>&1; then
  nohup node "$ROOT/gateway/control-plane.mjs" >"$ROOT/logs/control-plane.log" 2>&1 &
  echo "Started Personal AI OS control plane on http://127.0.0.1:4324"
fi

if ! curl -fsS --max-time 3 http://127.0.0.1:4326/health >/dev/null 2>&1; then
  if ! launchctl print "gui/$(id -u)/com.markus.personal-ai-os.goals" >/dev/null 2>&1; then
    nohup node "$ROOT/gateway/goals.mjs" >"$ROOT/logs/goals.log" 2>&1 &
    echo "Started continuous goals on http://127.0.0.1:4326"
  fi
fi

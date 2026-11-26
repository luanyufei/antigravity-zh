#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$HOME/.config/antigravity-insiders-i18n"
BIN_DIR="$HOME/.local/bin"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "错误：目前仅支持 macOS。" >&2
  exit 1
fi

INSIDERS_APP="/Applications/Antigravity - Insiders.app"
STABLE_APP="/Applications/Antigravity.app"
FOUND_APPS=()

if [ -n "${AGY_APP:-}" ]; then
  if [ -d "$AGY_APP" ]; then
    FOUND_APPS+=("$AGY_APP")
  else
    echo "错误：未找到指定路径 $AGY_APP" >&2
    exit 1
  fi
else
  [ -d "$INSIDERS_APP" ] && FOUND_APPS+=("$INSIDERS_APP")
  [ -d "$STABLE_APP" ] && FOUND_APPS+=("$STABLE_APP")
fi

if [ "${#FOUND_APPS[@]}" -eq 0 ]; then
  echo "错误：未在 /Applications 下检测到 Antigravity - Insiders.app 或 Antigravity.app。" >&2
  echo "如果安装在其他路径，可使用 AGY_APP=\"/path/to/Antigravity.app\" ./install.sh" >&2
  exit 1
fi

echo "检测到以下已安装的应用："
for app in "${FOUND_APPS[@]}"; do
  echo "  - $app"
done

mkdir -p "$TARGET_DIR/dict" "$TARGET_DIR/local-plugins/vibrancy-assets" "$TARGET_DIR/local-plugins/telemetry-assets" "$BIN_DIR"

cp "$REPO_DIR/src/patcher.py" "$TARGET_DIR/patcher.py"
cp "$REPO_DIR/src/main-hook.js" "$TARGET_DIR/main-hook.js"
cp "$REPO_DIR/src/renderer-i18n.js" "$TARGET_DIR/renderer-i18n.js"
cp "$REPO_DIR/dict/zh-CN.json" "$TARGET_DIR/dict/zh-CN.json"
cp "$REPO_DIR/src/local-plugins/vibrancy.js" "$TARGET_DIR/local-plugins/vibrancy.js"
cp "$REPO_DIR/src/local-plugins/vibrancy-assets/style.js" "$TARGET_DIR/local-plugins/vibrancy-assets/style.js"
cp "$REPO_DIR/src/local-plugins/telemetry.js" "$TARGET_DIR/local-plugins/telemetry.js"
cp "$REPO_DIR/src/local-plugins/telemetry-assets/preload.js" "$TARGET_DIR/local-plugins/telemetry-assets/preload.js"
cp "$REPO_DIR/src/local-plugins/telemetry-assets/metrics.js" "$TARGET_DIR/local-plugins/telemetry-assets/metrics.js"
cp "$REPO_DIR/src/local-plugins/telemetry-assets/overlay.js" "$TARGET_DIR/local-plugins/telemetry-assets/overlay.js"
chmod +x "$TARGET_DIR/patcher.py"

for variant in insiders stable; do
  if [ ! -f "$TARGET_DIR/local-plugins/vibrancy-${variant}.json" ]; then
    cat > "$TARGET_DIR/local-plugins/vibrancy-${variant}.json" <<'EOF'
{
  "enabled": true,
  "material": "fullscreen-ui",
  "opacity": 0.55
}
EOF
  fi
  if [ ! -f "$TARGET_DIR/local-plugins/telemetry-${variant}.json" ]; then
    cat > "$TARGET_DIR/local-plugins/telemetry-${variant}.json" <<'EOF'
{
  "showComposerBar": true,
  "showTurnFooter": true
}
EOF
  fi
done

if [ ! -f "$TARGET_DIR/dict/custom.json" ]; then
  cp "$REPO_DIR/dict/custom.json" "$TARGET_DIR/dict/custom.json"
fi

if [ ! -f "$TARGET_DIR/config.json" ]; then
  cat > "$TARGET_DIR/config.json" <<'EOF'
{
  "locale": "zh-CN",
  "showFloatingToggle": true,
  "autoPatchOnUpdate": true,
  "shortcut": "CmdOrCtrl+Option+L",
  "signingIdentity": ""
}
EOF
fi

cat > "$BIN_DIR/agy-i18n" <<'EOF'
#!/bin/sh
exec /usr/bin/python3 "$HOME/.config/antigravity-insiders-i18n/patcher.py" "$@"
EOF
chmod +x "$BIN_DIR/agy-i18n"

echo "正在为已检测到的应用注入引导并签名..."
if [ -n "${AGY_APP:-}" ]; then
  /usr/bin/python3 "$TARGET_DIR/patcher.py" patch --app "$AGY_APP"
else
  /usr/bin/python3 "$TARGET_DIR/patcher.py" patch
fi

echo "正在安装后台更新守护（同时监听两个版本，平时零占用）..."
/usr/bin/python3 "$TARGET_DIR/patcher.py" install-agent

echo ""
echo "安装完成！请按 ⌘Q 完全退出并重新打开对应的 Antigravity 应用即可生效。"
echo "常用命令：$BIN_DIR/agy-i18n status"

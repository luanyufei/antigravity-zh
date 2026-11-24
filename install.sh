#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$HOME/.config/antigravity-insiders-i18n"
BIN_DIR="$HOME/.local/bin"
APP_PATH="${AGY_INSIDERS_APP:-/Applications/Antigravity - Insiders.app}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "错误：目前仅支持 macOS。" >&2
  exit 1
fi

if [ ! -d "$APP_PATH" ]; then
  echo "错误：未找到 $APP_PATH，请确认已安装 Antigravity - Insiders。" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR/dict" "$TARGET_DIR/local-plugins/vibrancy-assets" "$BIN_DIR"

cp "$REPO_DIR/src/patcher.py" "$TARGET_DIR/patcher.py"
cp "$REPO_DIR/src/main-hook.js" "$TARGET_DIR/main-hook.js"
cp "$REPO_DIR/src/renderer-i18n.js" "$TARGET_DIR/renderer-i18n.js"
cp "$REPO_DIR/dict/zh-CN.json" "$TARGET_DIR/dict/zh-CN.json"
cp "$REPO_DIR/src/local-plugins/vibrancy.js" "$TARGET_DIR/local-plugins/vibrancy.js"
cp "$REPO_DIR/src/local-plugins/vibrancy-assets/style.js" "$TARGET_DIR/local-plugins/vibrancy-assets/style.js"
chmod +x "$TARGET_DIR/patcher.py"

if [ ! -f "$TARGET_DIR/local-plugins/vibrancy.json" ]; then
  cat > "$TARGET_DIR/local-plugins/vibrancy.json" <<'EOF'
{
  "enabled": true,
  "material": "fullscreen-ui",
  "opacity": 0.55
}
EOF
fi

if [ ! -f "$TARGET_DIR/dict/custom.json" ]; then
  cp "$REPO_DIR/dict/custom.json" "$TARGET_DIR/dict/custom.json"
fi

if [ ! -f "$TARGET_DIR/config.json" ]; then
  cat > "$TARGET_DIR/config.json" <<EOF
{
  "locale": "zh-CN",
  "showFloatingToggle": true,
  "autoPatchOnUpdate": true,
  "shortcut": "CmdOrCtrl+Option+L",
  "signingIdentity": "",
  "appPath": "$APP_PATH"
}
EOF
fi

cat > "$BIN_DIR/agy-i18n" <<'EOF'
#!/bin/sh
exec /usr/bin/python3 "$HOME/.config/antigravity-insiders-i18n/patcher.py" "$@"
EOF
chmod +x "$BIN_DIR/agy-i18n"

echo "正在注入汉化引导并签名..."
/usr/bin/python3 "$TARGET_DIR/patcher.py" patch --app "$APP_PATH"

echo "正在安装后台更新守护（仅文件变动时触发，平时零占用）..."
/usr/bin/python3 "$TARGET_DIR/patcher.py" install-agent

echo ""
echo "安装完成！请按 ⌘Q 完全退出并重新打开 Antigravity - Insiders 即可生效。"
echo "常用命令：$BIN_DIR/agy-i18n status"

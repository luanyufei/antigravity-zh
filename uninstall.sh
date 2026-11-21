#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="$HOME/.config/antigravity-insiders-i18n"
BIN_PATH="$HOME/.local/bin/agy-i18n"

if [ -f "$TARGET_DIR/patcher.py" ]; then
  echo "正在卸载后台更新守护..."
  /usr/bin/python3 "$TARGET_DIR/patcher.py" uninstall-agent || true

  echo "正在从备份还原官方原版应用..."
  /usr/bin/python3 "$TARGET_DIR/patcher.py" restore || echo "提示：未找到当前版本的本地备份，可重新下载官方安装包覆盖。"
fi

rm -f "$BIN_PATH"
echo "卸载完成。如需彻底清理配置与词典，可手动删除 $TARGET_DIR。"

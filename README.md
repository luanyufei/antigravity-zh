# antigravity-zh

**Antigravity - Insiders** 的中文汉化工具（**仅支持 macOS**），支持中英文随时热切换，应用更新后自动保持汉化。

## 它能做什么

- 汉化 Antigravity - Insiders 的主界面、设置页、Swarm 面板、macOS 顶部菜单栏、托盘菜单和系统弹窗，不误伤聊天内容、代码块、终端输出和内置浏览器网页。
- 支持中英文实时切换，不用重启应用，也不会破坏原版界面布局。
- 应用自动更新或手动覆盖安装后自动保持汉化，不需要每次更新完重新折腾。
- 备份当前版本的原始文件，随时可以一条命令还原回 Google 官方签名原版。

## 适用范围

目前这个项目**仅支持 macOS 版的 Antigravity - Insiders**。

- **普通版 Antigravity 用户**：打开你的 Antigravity 或其他 Agent，对它说：

```text
这个项目是针对 antigravity insiders 的，但是我的是普通版 antigravity，你帮我修改一下并安装：https://github.com/luanyufei/antigravity-zh
```

- **Windows / Linux 用户**：打开 Antigravity 或其他 Agent，对它说：

```text
这个项目目前只支持 macOS：https://github.com/luanyufei/antigravity-zh ，我现在用的是 Windows（或 Linux），请你参考它的汉化引擎和词典，帮我适配并安装到当前系统。
```

## 安装

```bash
git clone https://github.com/luanyufei/antigravity-zh.git
cd antigravity-zh
./install.sh
```

运行完成后，按 `⌘Q` 完全退出并重新打开 `Antigravity - Insiders` 即可生效。

如果安装脚本运行失败，请打开 Antigravity 或其他 Agent，对它说：

```text
帮我装好这个项目：https://github.com/luanyufei/antigravity-zh
```

## 同步最新汉化

如果仓库更新了词典补全或修复，想同步最新改动到本地，可以直接打开 Antigravity 或其他 Agent，对它说：

```text
请你检查 https://github.com/luanyufei/antigravity-zh 的最新变动，帮我把最新的汉化词典和脚本同步更新到本地。
```

## 中英文随时切换

安装后，下面四种方式都可以随时在中文和英文之间实时切换，不需要重启：

- 点击窗口右下角的悬浮按钮 `中 | EN`（按住可拖动位置，双击复位）
- 顶部菜单栏 `Antigravity - Insiders` → `语言 / Language`
- 快捷键 `⌘⌥L`
- 终端命令：`agy-i18n lang en` / `agy-i18n lang zh-CN` / `agy-i18n lang toggle`

## 常用命令与卸载

```bash
agy-i18n status           # 查看当前汉化、签名和更新守护状态
agy-i18n uninstall-agent  # 关闭后台更新监听守护（平时不占 CPU 和内存）
agy-i18n restore          # 从备份还原为官方原版签名
./uninstall.sh            # 卸载汉化并还原应用
```

如果想自己微调某些词条的翻译，可以直接编辑 `~/.config/antigravity-insiders-i18n/dict/custom.json`，保存后自动热生效。

## License

[MIT](LICENSE)

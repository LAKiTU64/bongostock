# 新设备 Codex 接续提示

这份文件用于在另一台设备或新的 Codex 任务中继续开发 BongoStock。当前事实以源码、[README](README.md)、[项目接续总览](docs/PROJECT_HANDOFF.md)和[资讯中心设计](docs/NEWS_CENTER_DESIGN.md)为准；Phase 文档仅是历史快照。

## 获取项目

```powershell
git clone https://github.com/LAKiTU64/bongostock.git
cd bongostock
corepack enable
pnpm install --frozen-lockfile
```

不要复制或提交 `node_modules/`、`target/`、`dist/`、安装包、日志、应用数据目录、`.bongoskin` 或 ZIP 文件。

## 可直接交给 Codex 的上下文

```text
请接续 BongoStock 项目。

仓库：https://github.com/LAKiTU64/bongostock
默认分支：main
版本：1.0.1
当前阶段：`1.0.1` 已发布（Windows x64 安装包与 macOS Apple Silicon DMG 已通过 GitHub Release 发布），工作区即该版本。资讯中心 Phase 0～6 已实现。

请先完整阅读：
1. README.md
2. docs/PROJECT_HANDOFF.md
3. docs/NEWS_CENTER_DESIGN.md
4. THIRD_PARTY_NOTICES.md
5. 与本次任务直接相关的代码

当前实现要点：
- Tauri 2 + Vue 3 + TypeScript + Pinia + Rust；
- 内置 MMmmmoko 标准模式和键盘模式，兼容 Awesome-BongoCat 模型目录；
- 可本地导入 layered-png-v1 .bongoskin/ZIP 皮肤；
- 项目外私人皮肤不在源码、Git 历史或公开构建中，不得补入仓库；
- 默认自选组包含上证指数、深证成指、沪深 300、科创 50；
- 行情支持分时、5 日、日 K，详情仅在点击证券后加载；
- 浮窗支持行情/资讯双模式，资讯只通过 Gateway 的 /v1/news/search 按需检索；
- 资讯支持1天、3天、7天和不限时间，最新优先，支持全市场、简报、个股及约10/20条两个档位；
- 行情数据源仅为外接的 BongoStock API v1（HTTP/HTTPS），客户端不内置任何本地行情源；Bearer Token 保存在本机应用数据并在重启后恢复；
- Windows 开发、构建和 NSIS 安装包已验证并发布，Apple Silicon DMG 本地构建已验证，macOS 仍需完整真机回归；
- 当前没有代码签名、macOS 公证或自动更新；Windows 安装包首次运行可能显示安全提醒。

修改前先检查 git status，保留用户未提交的改动。修改后至少执行：
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm run build:vite
pnpm run audit:release
cd src-tauri && cargo test --locked

只有用户明确要求发布时才 commit/push。不得上传私人皮肤包、凭据、本地设置、日志或构建产物。
```

## 本地私人数据

应用设置、计数、自选股和导入皮肤不属于 Git 仓库。需要迁移时，应在两台个人设备之间单独复制，并在复制前退出应用。项目外私人皮肤包不得放入公开仓库或发布产物。

更完整步骤见[设备迁移清单](docs/DEVICE_TRANSFER_CHECKLIST.md)。

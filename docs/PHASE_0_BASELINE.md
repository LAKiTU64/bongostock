# Phase 0 基线

日期：2026-08-07

## 项目

- 项目目录：`projects/BongoStock`
- 产品名：BongoStock
- 应用版本：0.1.0
- Bundle Identifier：`com.bongostock.desktop`
- 项目版本管理：未启用

## 底座

- BongoCat package version：1.1.0
- BongoCat License：MIT
- BongoCat 来源：<https://github.com/ayangweb/BongoCat>

## 已完成

- 建立无 `.git` 和 `.github` 元数据的项目副本；
- 修改前端包名和版本；
- 修改 Tauri 产品名与 Bundle Identifier；
- 修改 Rust crate 名称；
- 移除上游自动更新依赖、配置和界面入口；
- 移除版本发布脚本和 Git hooks 依赖；
- 保留 BongoCat MIT License；
- 增加第三方声明；
- 纳入产品方案和设备迁移清单。

## 本机工具链

- Node.js：26.4.0
- pnpm：11.12.0
- Apple Command Line Tools：26.6
- Rust：1.97.1 stable，aarch64-apple-darwin
- Cargo：1.97.1

## 验证结果

- `pnpm install`：通过，lockfile 已更新；
- pnpm 构建脚本允许列表：仅 `esbuild` 与 `@parcel/watcher`；
- `pnpm build`：通过；
- `pnpm exec tsc --noEmit`：通过；
- `pnpm exec eslint src`：通过；
- `cargo check`：通过；
- `pnpm tauri dev`：通过；
- Debug 可执行文件：`target/debug/bongo-stock`；
- 当前 Command Line Tools 足以完成 Debug 构建和运行；
- 完整 Xcode 仅在后续签名、归档或商店发布需要时评估。

非阻塞警告：

- Vite 主入口产物约 1.43 MB，触发 500 KB chunk size 提示；
- Rust 依赖 `block v0.1.6` 有 future-incompatibility 提示；
- 两项均不影响当前 Debug 构建和运行，进入性能或依赖升级阶段再处理。

## 当前说明

- 桌宠图标继续使用 BongoCat MIT 许可素材作为开发期占位图；
- 项目目录没有 `.git`、`.github` 或其他 Git 元数据；
- `node_modules/`、`dist/`、`target/` 是本机构建产物，迁移时排除；
- 当前 `target/` 体积约 4.9 GB，不应复制到个人设备。

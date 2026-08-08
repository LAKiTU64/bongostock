# Phase 3 基线

日期：2026-08-07

## 当前目标

验证 macOS 与 Windows 的桌宠、输入监听和按需行情面板核心流程。

## 当前启动方式

开发运行：

```bash
pnpm tauri dev
```

当前阶段不安装到系统应用目录，也不启用发布构建。跨平台核心验证完成后再执行：

```bash
pnpm tauri build
```

## 开机自启动

偏好设置 → 通用设置 → 开机自启动。

macOS 使用 Tauri autostart 插件的 LaunchAgent；Windows 使用对应平台的自启动机制。当前开关只控制登录时是否启动，不改变行情请求策略。

## 跨平台验证内容

- 透明无边框桌宠窗口；
- 桌宠拖动、短按、置顶、托盘和输入计数；
- 独立行情面板的打开、定位、失焦收起和 `Esc` 收起；
- macOS 输入监控权限；
- Windows 输入监听和权限提示；
- 两个平台在面板关闭后都不再请求行情。

## 行情边界

- 行情面板打开时请求一次；
- 用户手动点击 `刷新` 时再次请求；
- 面板关闭时不请求；
- 当前不启动自动轮询和交易日后台判断。

## 发布边界

- 当前构建未配置代码签名和公证；
- 安装包在跨平台核心验证完成后再生成；
- `.app`、`.dmg`、`.msi` 和 `.exe` 只用于对应平台的本地安装验证；
- 不在单位设备上创建 Git、提交、推送或发布操作；
- 转移到个人设备时复制源代码和锁文件，重新安装依赖并重新构建，不复制 `node_modules/`、`dist/` 或 `target/`。

## 验证记录

- macOS Apple Silicon：`pnpm tauri dev` 可以创建 main、preference 和 stock-panel 三个窗口；
- macOS Apple Silicon：桌宠和行情面板核心流程已在 Phase 2 运行验证；
- macOS 静态检查：`pnpm exec tsc --noEmit`、`pnpm exec eslint src`、`cargo check --locked` 通过；
- Windows：等待 Windows 设备执行本基线中的运行检查；
- Windows 目标检查至少包含：透明窗口、拖动、短按、置顶、托盘、键鼠计数、行情面板定位、`Esc` 收起和关闭面板后零请求。

## Windows 执行清单

在 Windows 设备的项目目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm tauri dev
```

运行时逐项检查：

1. 桌宠启动后保持透明、置顶并可拖动；
2. 键盘按下和鼠标点击会增加计数；
3. 短按打开行情面板，拖动不会误开；
4. 面板能定位在桌宠旁边，`Esc` 和失焦可以收起；
5. 面板打开或手动刷新时请求 Tencent，关闭后不再请求；
6. 托盘菜单可以打开设置和退出应用；
7. 需要时以管理员身份运行，确认系统级输入捕获稳定。

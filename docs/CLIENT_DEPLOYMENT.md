# BongoStock 客户端部署

本文说明如何在 Windows 和 macOS 上从源码运行、验证并构建 BongoStock 客户端。当前仓库尚未提供签名安装包或 GitHub Release；个人测试建议先使用 `tauri dev`，确认功能后再生成本机安装产物。

## 1. 支持范围

| 平台 | 当前状态 | 构建产物 | 额外要求 |
| --- | --- | --- | --- |
| Windows 10/11 x64 | 已在 Windows 11 x64 实机开发和回归 | NSIS `.exe` | WebView2、MSVC Build Tools、Windows SDK |
| macOS Apple Silicon / Intel | 代码和 Tauri 配置已适配，仍需 Mac 真机回归 | `.app`、`.dmg` | Apple Command Line Tools、Input Monitoring 权限 |

默认构建当前机器的 CPU 架构。Intel Mac 生成 `x86_64`，Apple Silicon 生成 `aarch64`；通用二进制见本文第 5 节。

## 2. 通用依赖与获取代码

建议使用 Node.js 22 LTS、pnpm、Rust stable 和 Git。Node.js 18 是当前前端依赖的最低保守基线，但新设备优先使用 Node.js 22 LTS。

```bash
git clone https://github.com/LAKiTU64/bongostock.git
cd bongostock
corepack enable
pnpm install --frozen-lockfile
rustup default stable
```

每次换设备或升级依赖后先执行：

```bash
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm run build:vite
pnpm run audit:release
```

完整桌宠必须通过 Tauri 启动：

```bash
pnpm tauri dev
```

`pnpm dev` 只启动浏览器中的 Vite 页面，不能验证托盘、透明窗口、全局输入、系统权限或本地 Store。

## 3. Windows 部署

### 3.1 系统依赖

安装以下组件后重新打开 PowerShell：

- Microsoft Edge WebView2 Runtime；Windows 11 和多数已更新的 Windows 10 已自带；
- Visual Studio 2022 Build Tools；勾选“使用 C++ 的桌面开发”；
- MSVC v143、Windows 10/11 SDK 和 C++ CMake tools；
- Rust 的 `stable-x86_64-pc-windows-msvc` 工具链。

检查环境：

```powershell
node --version
pnpm --version
rustc --version
cargo --version
rustup show active-toolchain
```

如果 `cargo` 只在默认安装目录中，可直接使用：

```powershell
& "$env:USERPROFILE\.cargo\bin\cargo.exe" check --locked
```

### 3.2 开发运行与本地构建

```powershell
pnpm tauri dev
pnpm tauri build --debug --no-bundle
```

Debug 可执行文件通常位于：

```text
target\debug\bongo-stock.exe
```

生成 NSIS 安装包：

```powershell
pnpm tauri build --bundles nsis
```

安装包通常位于 `target\release\bundle\nsis\`。当前安装包未签名，Windows SmartScreen 可能提示未知发布者；只应在自己构建并确认哈希的机器上测试，不要把未审核产物当作正式发行版。

### 3.3 Windows 权限

普通权限可以运行桌宠和行情功能。部分系统级按键可能被高权限程序隔离；只有确实需要捕获这些输入时才以管理员身份启动。设置页的“不再提示管理员权限”仅关闭提醒，不改变进程权限。

## 4. macOS 部署

### 4.1 系统依赖

```bash
xcode-select --install
node --version
pnpm --version
rustc --version
cargo --version
```

若尚未安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup default stable
```

### 4.2 开发运行和权限

```bash
pnpm tauri dev
```

第一次运行后进入：

```text
系统设置 → 隐私与安全性 → 输入监控
```

允许 BongoStock 或当前开发终端捕获输入，然后完全退出并重新启动应用。没有此权限时，窗口和行情仍可显示，但全局按键/鼠标计数可能不工作。

### 4.3 构建 `.app` 和 `.dmg`

```bash
pnpm tauri build --bundles app,dmg
```

产物通常位于：

```text
target/release/bundle/macos/
target/release/bundle/dmg/
```

当前项目使用 macOS 私有窗口能力实现桌面浮层，不面向 Mac App Store。对其他用户分发前仍需要 Apple Developer ID 签名、公证和 Gatekeeper 真机验证；仅在本机从源码构建测试时可以暂不配置签名。

## 5. 可选：macOS 通用二进制

需要同时支持 Intel 和 Apple Silicon 时，在 Mac 上安装两个 Rust target：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target universal-apple-darwin --bundles app,dmg
```

通用构建必须在 macOS 上执行。任何一个依赖无法交叉编译时，应先分别构建两种架构定位问题，不要直接发布未验证的 universal 产物。

## 6. 连接外接行情网关

打开“偏好设置 → 行情”，选择“外接行情服务”，填写：

- 服务地址：`https://<服务器域名或公网 IP>`；
- Bearer Token：服务端 `/etc/bongostock-gateway.env` 中的 `BONGOSTOCK_TOKEN`；
- 超时：默认 8,000 ms。

点击“测试连接”。成功后只请求 `/v1/capabilities`，不会携带证券代码。Token 会明文保存在当前用户的应用数据中并在重启后恢复，请勿上传或分享这些文件。

常见 Store 位置：

```text
Windows 开发：%APPDATA%\com.bongostock.desktop\tauri-plugin-pinia\market.dev.json
Windows 发布：%APPDATA%\com.bongostock.desktop\tauri-plugin-pinia\market.json
macOS 开发：~/Library/Application Support/com.bongostock.desktop/tauri-plugin-pinia/market.dev.json
macOS 发布：~/Library/Application Support/com.bongostock.desktop/tauri-plugin-pinia/market.json
```

## 7. 发布前检查

```bash
git status --short
git diff --check
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm run build:vite
pnpm run audit:release
cargo test --locked
```

还需要人工验证：

- 两套内置 MMmmmoko 模型、鼠标和键盘反馈；
- 透明窗口、拖动、托盘、置顶、穿透和缩放；
- 默认四个指数、报价、分时、5 日和日 K；
- 外接 HTTPS、错误 Token、断网和重启后 Token 恢复；
- Windows 普通/管理员权限差异；
- macOS Input Monitoring 授权前后的行为；
- 仓库和产物不包含 StrayRogue/Steam 私人皮肤、Token 或本机配置。

## 8. 当前交付边界

- Windows 已有实机开发验证，macOS 尚缺持续集成和真机回归；
- 没有自动更新、Windows 代码签名、Apple 签名或公证；
- NSIS 和 DMG 配置存在，但尚未作为正式 Release 发布；
- 设备迁移和私人皮肤边界见 [DEVICE_TRANSFER_CHECKLIST.md](DEVICE_TRANSFER_CHECKLIST.md)。

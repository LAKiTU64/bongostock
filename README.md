# BongoStock

BongoStock 是一款供个人使用的 Windows/macOS 紧凑桌宠。它记录键盘按下和鼠标点击次数、响应输入动作，并在用户主动点击桌宠时打开自选行情浮窗。

- 当前版本：`0.1.0`
- 当前阶段：Phase 6，公开源码后的个人 Alpha 稳定化
- 公开仓库：<https://github.com/LAKiTU64/bongostock>
- 默认分支：`main`
- 软件包状态：尚未发布正式安装包、签名构建或 GitHub Release

## 当前功能

### 桌宠

- 键盘按下和鼠标点击累计计数，计数保存在本机；
- 鼠标、键盘和左右猫爪动作反馈；
- 透明、无边框、可拖动、可置顶窗口；
- 托盘、窗口穿透、透明度、保持在屏幕内和开机自启动；
- 桌宠尺寸可在 50%～300% 之间连续调节；
- 计数框按最多 9 位数 `999 999 999` 设计；
- Windows 提供管理员权限说明和“不再提示管理员权限”开关。

### 模型与皮肤

公开仓库内置两套 MMmmmoko 模型，均使用与 [Awesome-BongoCat](https://github.com/ayangweb/Awesome-BongoCat) 兼容的 Live2D 目录结构：

- `builtin:mmmmmoko`：`经典小键盘 · 标准模式`，包含鼠标垫、键盘、鼠标反馈和标准模式键位图层；
- `builtin:mmmmmoko-keyboard`：`经典小键盘 · 键盘模式`，包含左右爪与键位图层。

内置模型复用原版 BongoCat 的背景、Live2D 和键位叠图坐标体系；同一只爪同时只显示最后按下的一个键位反馈。BongoStock 自己的计数框和 SVG 菜单框保持在模型下方。

自定义外观通过本地 `.bongoskin`/ZIP 包导入，当前支持 `layered-png-v1`：左右爪各有静止和拍下图层。导入器限制压缩包大小、文件数量、单文件大小和路径，并拒绝目录穿越与可执行内容。

StrayRogue/Steam 素材不在本仓库、不在内置资源、不在 Git 历史中，也不会进入公开构建。个人本地皮肤只能从项目外导入；未取得明确再分发许可前不得上传或打包。

### 自选行情

- 点击桌宠打开独立行情浮窗；
- 每次打开时按桌宠当前位置重新定位，优先显示在下方，空间不足时显示在上方；
- 浮窗可拖动，点击外部区域关闭，`Esc` 始终可以关闭；
- 常驻按钮只对当前一次打开有效；
- 最多 8 个分组，全部分组合计最多 50 只沪深股票、指数或场内基金；
- 列表采用紧凑双栏布局；
- 支持 `SH600036`、`SZ000858` 和 6 位纯数字代码；
- 纯数字代码按沪深规则补齐交易所，并在线匹配证券名称；
- 新数据默认建立“自选股”分组，包含上证指数、深证成指、沪深 300、科创 50；
- 默认无操作 2 秒后淡出至 28% 不透明度；等待时间和淡出程度均可调；
- 打开浮窗或手动刷新时请求一次报价，浮窗关闭时不轮询；
- 点击证券后按需加载分时、5 日和日 K；
- 图表悬停显示对应时间/日期与价格，日 K 同时显示开、高、低、收。

## 行情数据源

### 内置数据源

- 报价与日 K：精确锁定的 `stock-api@2.7.3`；
- 分时/5 日：优先请求东方财富公开走势接口，失败后回退腾讯公开接口；
- 报价每批最多 25 个代码；
- 分时缓存 30 秒，日 K 缓存 5 分钟；
- 详细数据只在打开证券详情时加载。

这些数据只用于个人辅助参考，不能替代券商终端。

### 外接数据源

设置页可切换到 BongoStock API v1，支持 HTTP/HTTPS、Bearer Token 和 1～30 秒超时。外接模式不会静默回退内置源；Token 会保存在本机应用数据中并在重启后自动恢复，请勿分享或提交本地配置文件。

外接服务需要实现：

```text
GET  /v1/capabilities
POST /v1/quotes
POST /v1/search
POST /v1/trends
POST /v1/klines
```

完整请求与响应约定见 [`docs/EXTERNAL_MARKET_API_V1.md`](docs/EXTERNAL_MARKET_API_V1.md)。证券代码放在 POST body 中只能减少 URL/访问日志暴露；HTTP 仍是明文，HTTPS 也不能隐藏外接服务器自身看到的代码。

## 技术栈

- Tauri 2
- Vue 3、TypeScript、Pinia
- Rust stable
- Vite
- PixiJS、easy-live2d
- stock-api 2.7.3

## 本地开发

需要 Node.js、pnpm、Rust stable，以及目标平台的 Tauri 构建依赖。

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm run build:vite
cargo check --locked
pnpm tauri dev
```

`pnpm dev` 只启动前端开发服务器；运行完整桌宠应使用 `pnpm tauri dev`。

### Windows

需要 WebView2、Microsoft C++ Build Tools 和 `stable-x86_64-pc-windows-msvc`。生成 NSIS `.exe` 安装包的配置已经存在，但当前没有发布安装包：

```powershell
pnpm tauri build --bundles nsis
```

### macOS

需要 Apple Command Line Tools；捕获全局输入需要 Input Monitoring 权限。DMG 必须在 macOS 上构建：

```bash
pnpm tauri build --bundles dmg
```

对外分发仍需 Apple Developer 签名与公证。

## 发布安全

发布或打包前执行：

```bash
pnpm run audit:release
```

`.gitignore` 已排除 `*.bongoskin`、ZIP、本地快照、依赖和构建产物。发布审计和 Git 忽略规则是辅助防线，不能替代人工确认第三方模型授权。

## 文档

- 当前功能基线：[`docs/PHASE_6_BASELINE.md`](docs/PHASE_6_BASELINE.md)
- 项目接续总览：[`docs/PROJECT_HANDOFF.md`](docs/PROJECT_HANDOFF.md)
- 产品与技术方案：[`docs/BongoStock_Product_Spec_v0.1.md`](docs/BongoStock_Product_Spec_v0.1.md)
- 外接行情协议：[`docs/EXTERNAL_MARKET_API_V1.md`](docs/EXTERNAL_MARKET_API_V1.md)
- 新设备接续提示：[`HANDOFF_PROMPT.md`](HANDOFF_PROMPT.md)
- 设备迁移/克隆清单：[`docs/DEVICE_TRANSFER_CHECKLIST.md`](docs/DEVICE_TRANSFER_CHECKLIST.md)
- Phase 0～5：历史实施快照，不代表当前功能上限

## 素材与署名

- 跨平台工程底座来自 [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat)，遵循其 MIT License；
- 内置模型来源链指向 [MMmmmoko/Bongo-Cat-Mver](https://github.com/MMmmmoko/Bongo-Cat-Mver)，模型索引与包格式参考 [ayangweb/Awesome-BongoCat](https://github.com/ayangweb/Awesome-BongoCat)；
- Bongo Cat 原始形象由 **StrayRogue** 创作；Steam 的 Bongo Cat 页面注明游戏基于其画作与梗图；
- 行情模块使用 [zhangxiangliang/stock-api](https://github.com/zhangxiangliang/stock-api) 2.7.3。

完整声明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 当前不做

- 自动交易或券商账户操作；
- 后台行情轮询和交易日服务；
- 周 K、月 K、提醒、AI 分析或 MCP；
- 自动更新、代码签名、公证和正式二进制发布。

# BongoStock

## 模型与皮肤

BongoStock 现在内置两套来自 MMmmmoko 的 BongoCat 模型：

- `经典小键盘 · 标准模式`：标准 Live2D 模型，包含鼠标垫、键盘和鼠标点击反馈；
- `经典小键盘 · 键盘模式`：键盘输入模式，支持左右爪和按键图层。

两套模型来自用户提供的官方 BongoCat 模型包，模型格式与 [Awesome-BongoCat](https://github.com/ayangweb/Awesome-BongoCat) 兼容。其他作者的 BongoCat Live2D 模型后续可按同一目录结构导入。

现有的 BongoStock 分层 PNG 皮肤仍可通过 `.bongoskin` 导入；它与 Live2D 模型使用不同渲染引擎，但在设置页统一展示和切换。Steam/StrayRogue 素材继续只允许个人本地使用，不进入公开发布包。

BongoStock 是一款供个人使用的 Windows/macOS 紧凑桌宠：记录键盘和鼠标点击次数、响应输入拍爪，并在用户需要时打开自选行情浮窗。

当前处于个人使用 Alpha 稳定化阶段。核心功能已经可用，暂不制作安装包，也不把素材授权尚未确认的本机皮肤发布到公开仓库。

## 当前功能

### 桌宠

- 键盘按下和鼠标点击累计计数，计数本地持久化；
- 左右拍爪反馈；
- 透明、无边框、置顶、可拖动窗口；
- 托盘、窗口穿透、透明度和开机自启动；
- 桌宠尺寸可在 50%～300% 之间连续调节；
- 默认内置 MMmmmoko 的 BongoCat 标准模式和键盘模式；其他皮肤通过受限的 `.bongoskin` 本地皮肤包导入；
- Windows 管理员权限说明及“不再提示管理员权限”开关。

### 自选行情

- 点击桌宠打开独立行情浮窗；
- 每次打开时根据桌宠位置重新定位，优先显示在下方，空间不足时显示在上方；
- 浮窗可拖动，点击外部区域关闭，`Esc` 始终可关闭；
- 常驻按钮只对当前一次打开有效；
- 支持多个分组，行情列表采用紧凑双栏布局；
- 支持最多 50 只沪深股票或场内基金；
- 可以输入 `SH600036`、`SZ000858`，也可以直接输入 6 位代码；
- 纯数字代码根据沪深代码规则自动补齐交易所，在线匹配时显示证券名称；
- 淡出等待时间和淡出后的透明度可调，默认 2 秒后淡出；
- 打开浮窗或点击刷新时请求一次行情，浮窗关闭时不轮询；
- 行情数据源可选择内置 `stock-api` 或外接 BongoStock API v1 服务；外接地址支持 HTTP/HTTPS，默认不自动回退内置源。
- 点击任意证券后才加载详细行情，提供分时、5 日和日 K 三种视图；
- 鼠标悬停图表时显示对应时间/日期和价格，日 K 同时显示开高低收；
- 详细行情按需加载，不在列表页或浮窗关闭时请求。

行情列表的内置源使用精确锁定的 `stock-api@2.7.3` 批量接口；详细分时数据按需使用东方财富/腾讯公开走势接口。外接源需要实现项目定义的 BongoStock API v1。它们是个人辅助信息，不应替代券商终端。

### 外接行情协议

外接服务提供以下接口，并返回 JSON：

```text
GET  /v1/capabilities
POST /v1/quotes   { "codes": ["SH000001"] }
POST /v1/search   { "query": "000001" }
POST /v1/trends   { "code": "SH000001", "days": 1 }
POST /v1/klines   { "code": "SH000001", "period": "day", "count": 30 }
```

响应约定：`/v1/quotes` 返回 `[{ code, name, now, low, high, percent, yesterday }]`（`percent` 使用小数，例如 `0.01` 表示 1%）；`/v1/search` 返回 `[{ code, name }]`；`/v1/trends` 返回 `{ code, name, preClose, points }`，其中 `points` 至少包含 `timestamp`、`close`，可选 `open/high/low/volume/amount/average`；`/v1/klines` 返回 `[{ date, open, close, high, low, volume }]`。

行情代码使用 POST body，能够减少 URL/访问日志中的暴露，但 HTTP 仍会明文传输；HTTPS 只能降低传输链路暴露，不能隐藏外接服务器自身看到的代码。

## 技术栈

- Tauri 2
- Vue 3、TypeScript、Pinia
- Rust stable MSVC
- Vite
- stock-api 2.7.3

## 本地开发

要求：Node.js、pnpm、Rust stable，以及目标平台的 Tauri 构建依赖。

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm run build:vite
cargo check --locked
pnpm tauri dev
```

`pnpm dev` 只启动前端开发服务器；运行完整桌宠应使用 `pnpm tauri dev`。

## 文档

- 当前接续总览：`docs/PROJECT_HANDOFF.md`
- 当前功能基线：`docs/PHASE_5_BASELINE.md`
- 产品与技术方案：`docs/BongoStock_Product_Spec_v0.1.md`
- 外接行情协议：`docs/EXTERNAL_MARKET_API_V1.md`
- 新设备接续提示：`HANDOFF_PROMPT.md`
- 设备迁移清单：`docs/DEVICE_TRANSFER_CHECKLIST.md`
- Phase 0～4：历史实施记录，不代表当前功能上限

## 素材与署名

- 跨平台工程及 Live2D 标准模型来自 [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat)，其标准模型来源链指向 [MMmmmoko/Bongo-Cat-Mver](https://github.com/MMmmmoko/Bongo-Cat-Mver)。界面以 **MMmmmoko** 标识这套模型。
- Bongo Cat 原始形象由 **StrayRogue** 创作；Steam 的 Bongo Cat 页面也注明其作品基于 @StrayRogue 的画作与梗图。
- StrayRogue 皮肤包只保存在项目外的个人目录，通过“导入皮肤包”使用；它来自用户本机安装的游戏，仅供当前个人设备本地使用。在获得明确再分发授权前，不得上传皮肤包、源图片或发行包。
- 行情模块使用 [stock-api](https://github.com/zhangxiangliang/stock-api) 2.7.3。

完整声明见 `THIRD_PARTY_NOTICES.md`。

## 当前不做

- 自动交易、券商账户操作；
- 后台行情轮询、交易日服务；
- 周 K、月 K、提醒、AI 分析；
- 安装包、自动更新和公开发布。

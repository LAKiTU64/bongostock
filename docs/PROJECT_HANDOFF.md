# BongoStock 项目接续总览

更新日期：2026-08-08

## 当前阶段

BongoStock 已完成个人使用 Alpha 的主要功能，当前进入稳定化与日常使用观察阶段。早期 `PHASE_0_BASELINE.md`～`PHASE_4_BASELINE.md` 是历史实施记录；当前状态以本文件和 `PHASE_5_BASELINE.md` 为准。

安装包、公开仓库和正式发布暂不在当前范围内。

## 产品边界

- 桌宠收起时不显示证券信息；
- 行情浮窗打开时请求一次，手动刷新时再请求一次；
- 浮窗关闭后不请求行情，不启动后台定时轮询；
- 列表报价默认使用 `stock-api@2.7.3`，也可切换为外接 BongoStock API v1；
- 不做自动交易、周 K/月 K、提醒、AI 分析或多数据源比较；
- 行情仅供个人辅助参考，以券商终端为准。

## 当前功能

### 桌宠与输入

- Windows/macOS Tauri 透明无边框窗口；
- 键盘按下和鼠标点击累计计数；
- 左右拍爪响应，计数使用 Pinia + Tauri Store 本地保存；
- 拖动、置顶、穿透、透明度、托盘和开机自启动；
- 尺寸可在 50%～300% 连续调节；
- 计数框最多按 9 位数 `999 999 999` 设计；
- Windows 提供管理员权限状态、操作说明及“不再提示”开关。

### 皮肤

- `builtin:mmmmmoko`：MMmmmoko 的 Bongo-Cat-Mver Live2D 标准模型，由 ayangweb/BongoCat 收录；这是唯一内置皮肤；
- 其他皮肤通过受限的 `.bongoskin` 数据包导入，导入文件保存在应用数据目录；
- `github`/`steam` 只作为旧配置的兼容标识，用户界面显示作者名或皮肤包名称；
- 导入包只允许 PNG、JSON 和 NOTICE 文件，限制大小、数量和路径，禁止可执行内容；
- StrayRogue 包保存在项目外的个人目录，不进入源码、构建产物或公开发布；
- 所有皮肤共享计数、拍爪、菜单和窗口缩放功能；
- 本机游戏素材仅限本地使用，在获得明确许可前不得进入公开仓库或发行包。

### 行情浮窗

- 点击桌宠切换独立 `stock-panel` 窗口；
- 每次打开都按桌宠当前位置重新计算：优先下方、空间不足时上方，并限制在当前显示器工作区；
- 浮窗可拖动，但拖动位置不作为下一次打开位置；
- 点击桌宠和浮窗之外的区域默认关闭；
- 当前打开期间可以临时常驻，下一次打开恢复为非驻留；
- `Esc` 始终有效；
- 多分组横向标签和双栏紧凑行情列表；
- 默认 2 秒无操作后淡出，等待时间和淡出透明度均可设置；
- 显示名称、代码、价格、涨跌幅和更新时间；
- 打开或手动刷新时各请求一次，使用 loading 锁避免重复并发。
- 点击证券后才请求详细数据，提供分时、5 日和日 K；图表悬停显示价格，日 K 显示开高低收；
- 详细走势请求失败时不影响列表行情；详情页保留重试入口。

### 自选与代码匹配

- 最多 8 个分组、总计最多 50 只股票或基金；
- 分组支持创建、重命名和删除，至少保留一个分组；
- 支持 `SH`/`SZ` 加 6 位代码，也支持直接输入 6 位代码；
- 纯数字代码按沪深规则补齐交易所，并可调用在线搜索确认证券名称与候选项；
- 自动去重，同一代码不能重复出现在不同分组；
- 新设备默认创建一个“自选股”分组，包含上证指数、深证成指、沪深 300、科创 50；
- 支持 `588170`、`589850` 等场内基金代码；
- 设置页同时显示证券名称与统一代码。

### 行情数据源

- 外接服务支持 HTTP/HTTPS，并限制在配置主机及 `/v1/` 路径；
- 外接模式默认不自动回退内置源，避免用户误以为没有发生外部请求；
- Bearer Token 只在当前运行期间保存在内存，不写入 Pinia Store；
- 代码放在 POST body 中以减少 URL/访问日志暴露，但 HTTP 仍不加密，HTTPS 仍不能隐藏外接服务器自身看到的代码。

## 性能基线（Windows 开发运行）

整个 Tauri/WebView2 进程树静置采样：

| 皮肤 | 总 CPU | 私有内存 | 持续 3D GPU |
|---|---:|---:|---:|
| MMmmmoko Live2D | 约 2.20% | 约 530.5 MB | 约 1.26% |
| StrayRogue 静态图层 | 约 0.57% | 约 488.8 MB | 采样期未检测到持续占用 |

当前配置会预创建 main、preference、stock-panel 三个 WebView，因此总内存看起来偏高。个人使用阶段暂不为此重构窗口生命周期。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/components/CompactCat.vue` | 内置 Live2D、导入图层皮肤、计数框、菜单 SVG 与拍爪图层 |
| `src/pages/main/index.vue` | 主窗口尺寸、缩放、拖动、点击和输入入口 |
| `src/composables/useStockPanel.ts` | 浮窗开关、自适应定位和屏幕边界处理 |
| `src/pages/stock-panel/index.vue` | 分组、双栏行情、常驻、淡出与关闭交互 |
| `src/market/marketService.ts` | 内置/外接行情 Provider、批量报价、详细走势、日 K 与证券代码匹配 |
| `src/stores/watchlist.ts` | 默认分组、50 只上限、增删、迁移与面板设置 |
| `src/pages/preference/components/market/index.vue` | 分组和自选设置 UI |
| `src/pages/preference/components/cat/index.vue` | 皮肤和 50%～300% 窗口缩放设置 |
| `src/pages/preference/components/general/components/windows-permissions/index.vue` | Windows 管理员权限说明和提示开关 |
| `src/stores/cat.ts` | 桌宠设置、当前皮肤和累计计数 |
| `src/stores/skin.ts` | 内置/导入皮肤注册表与旧配置迁移 |
| `src-tauri/src/utils/skin.rs` | `.bongoskin` 安全校验、解压、列举和删除 |
| `src-tauri/src/utils/market.rs` | 受限 HTTP/HTTPS 外接行情请求 |
| `src-tauri/tauri.conf.json` | 三个窗口、资源和打包配置 |

## 当前验证结果

- Windows 开发依赖已经配置，可以运行 `pnpm tauri dev`；
- 桌宠、内置皮肤、导入皮肤、缩放、计数、菜单和行情浮窗已通过构建链路验证；
- 多分组、50 只上限、纯代码匹配、基金代码和设置持久化已实现；
- 浮窗外部点击、临时常驻、`Esc`、淡出和自适应位置已实机验证；
- 最新相关 ESLint 检查和 Vite 生产构建通过；
- Vite 主包约 1.24 MB，存在非阻塞的大包提示；
- 当前没有自动化测试文件。个人项目只在后续重构核心数据逻辑时考虑少量防回归测试。

## 下一步

1. 继续个人日常使用，记录真实出现的问题；
2. 最新改动在 macOS 设备上做一次轻量回归，重点检查字体、缩放、权限与透明窗口；
3. 保持文档与行为同步；
4. 公开发布时只打包 MMmmmoko；StrayRogue `.bongoskin` 必须排除，除非取得明确再分发授权；
5. 用户明确需要时再考虑安装包。

不要主动扩展为复杂测试体系，也不要自行增加自动轮询、交易服务、周 K/月 K、提醒、AI 或 MCP。

## 新设备启动

不要跨设备复用 `node_modules/`、`dist/` 或 `target/`。

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm run build:vite
cargo check --locked
pnpm tauri dev
```

当前没有建立版本管理历史。除非用户在当前任务明确授权，不执行 `git init`、提交、推送、tag 或发布。

## 2026-08-08 模型兼容更新

- 内置模型同时提供 `经典小键盘 · 标准模式` 和 `经典小键盘 · 键盘模式`。
- 两套模型使用 Awesome-BongoCat 兼容的 Live2D 目录结构；标准模式的背景层包含鼠标垫和键盘。
- 键盘模式读取 `resources/left-keys`、`resources/right-keys`，并将全局键盘事件映射到左右爪和按键图层。
- 原有 `.bongoskin` 分层 PNG 导入继续保留，作为独立的 BongoStock 自定义皮肤引擎。
- `builtin:mmmmmoko` 继续指向标准模式；新增 `builtin:mmmmmoko-keyboard` 指向键盘模式。

模型来源索引：[ayangweb/Awesome-BongoCat](https://github.com/ayangweb/Awesome-BongoCat)。第三方模型的作者和授权仍需逐包确认，发布时不自动打包未获再分发许可的模型。

# BongoStock 项目接续总览

更新日期：2026-08-10

## 当前阶段

BongoStock 已进入 `v1.0.0` 首个正式版本，资讯中心 Phase 0～6 已实现。主要功能已经可用，后续工作重点是实际使用、macOS 回归和保持文档一致。

- 公开仓库：<https://github.com/LAKiTU64/bongostock>
- 默认分支：`main`
- 应用版本：`1.0.0`
- Bundle Identifier：`com.bongostock.desktop`
- 正式发布：Windows x64 安装包通过 GitHub Release 发布；暂无代码签名、公证或自动更新

Phase 0～6 文档是历史实施快照；当前状态以 README、本文件、`NEWS_CENTER_DESIGN.md` 和实际代码为准。

## 产品边界

- 桌宠收起时不显示证券信息；
- 行情浮窗打开或手动刷新时请求报价，关闭后不后台轮询；
- 详情数据只在点击证券后加载；
- 默认使用内置行情源，也可显式切换到外接 BongoStock API v1；
- 资讯仅在用户点击搜索或刷新时通过已配置的 BongoStock Gateway 请求；
- 不做自动交易、券商账户控制、周 K/月 K、提醒、本地 AI/MCP 或后台交易日服务；
- 行情仅供个人辅助参考，以券商终端为准。

## 当前功能

### 桌宠与输入

- Windows/macOS Tauri 透明无边框窗口；
- 全局键盘按下和鼠标点击累计计数，使用 Pinia + Tauri Store 本地保存；
- 计数框按最多 9 位数 `999 999 999` 设计；
- 拖动、置顶、穿透、透明度、保持在屏幕内、托盘和开机自启动；
- 尺寸在 50%～300% 连续调节；
- Windows 提供管理员权限状态、操作说明和“不再提示”开关。

### 模型与皮肤

- `builtin:mmmmmoko`：MMmmmoko 经典小键盘标准模式；
- `builtin:mmmmmoko-keyboard`：MMmmmoko 经典小键盘键盘模式；
- 两套模型使用 Awesome-BongoCat 兼容目录，公开仓库内置背景、Live2D、键位图层和预览；
- 标准模式显示鼠标垫与键盘；键位图层与背景共用原版坐标体系，同侧只显示最后一个按键反馈；
- 鼠标使用模型专用参数，键盘资源目录决定左右爪动作；
- BongoStock 计数框和 SVG 菜单框保留在模型下方；
- 自定义皮肤使用 `layered-png-v1`，通过 `.bongoskin`/ZIP 导入；
- 导入器校验清单、大小、文件数量、扩展名和路径，防止目录穿越；
- 导入皮肤拍爪时动作爪层位于两个方框上方；
- 旧设置别名只用于本地数据迁移，不对应公开内置资源；
- 项目外私人皮肤不在源码、Git 历史或公开构建中。

### 行情浮窗

- 点击桌宠切换独立 `stock-panel`；
- 首次打开或临时状态回收后按桌宠位置重新计算坐标：优先下方、空间不足时上方，并限制在显示器工作区；
- 浮窗可拖动；外部点击关闭后默认保留模式、详情、筛选状态和拖动位置 30 秒，期间重新打开或切换模式不重新定位；
- 点击桌宠和浮窗之外的区域默认关闭；
- 临时常驻只对当前一次打开有效；
- `Esc` 始终有效；
- 顶部提供行情/资讯模式、常驻、刷新和专用拖拽手柄；
- 横向分组标签和双栏紧凑列表；
- 默认 2 秒无操作后淡出至 28%，等待范围 1～300 秒，不透明度范围 10%～100%；
- 显示名称、统一代码、价格、涨跌幅和更新时间；
- 打开或手动刷新时请求报价，使用 loading 锁避免重复并发。

### 自选与代码匹配

- 最多 8 个分组、所有分组合计最多 50 个证券；
- 分组支持创建、重命名和删除，至少保留一个；
- 支持 `SH`/`SZ` + 6 位代码，也支持直接输入 6 位代码；
- `5`/`6` 开头默认补为上海，`0`～`3` 开头默认补为深圳；
- 在线搜索确认证券名称与候选项；
- 同一证券不能跨组重复；
- 新数据默认“自选股”包含上证指数、深证成指、沪深 300、科创 50；
- 支持 `588170`、`589850` 等场内基金代码。

### 详情图表

- 点击证券后并行加载分时、5 日和日 K；
- 分时/5 日优先东方财富，失败时回退腾讯；
- 日 K 使用 `stock-api@2.7.3`；
- 分时缓存 30 秒，日 K 缓存 5 分钟；
- 分时显示四个时间刻度和午间分割线，5 日/日 K 显示首尾日期；
- 图表悬停显示时间/日期和价格，日 K 显示开高低收；
- 详情失败不影响列表报价，并保留刷新/重试入口。

### 行情数据源

- 默认内置源：`stock-api@2.7.3`、东方财富与腾讯公开接口；
- 可切换外接 BongoStock API v1；
- 外接支持 HTTP/HTTPS、Bearer Token 和 1～30 秒超时；
- 外接模式不静默回退内置源；
- Token 保存在本机应用数据中，重启后自动恢复；配置文件不得提交或公开分享；
- Rust 层限制 GET/POST、配置主机、`/v1/` 路径和 2 MB 响应，禁止重定向；
- 代码位于 POST body 只能减少 URL 日志暴露，不能对外接服务器隐藏代码。

### 资讯中心

- 全市场、简报和个股三个范围；个股联动本地分组、股票、指数和场内基金；
- 内置检索主题与临时自定义完整检索词，不保存搜索历史或检索词收藏；
- 客户端提供 1 天、3 天、7 天和不限四档时间范围，固定最新优先，并提供约 10 条和约 20 条两个召回档位；
- 条件变化不自动请求，只有搜索按钮或顶部刷新会调用 Gateway；
- 使用已配置的 Gateway 地址和 Bearer Token，与当前行情选择内置/外接无关；
- 客户端不直连妙想、不保存 `MX_APIKEY`、不包含本地资讯 Provider 或回退源；
- 新闻支持已读淡化；点击条目进入同浮窗二级详情页完整阅读 Gateway 返回内容，并可返回列表或使用系统浏览器打开原文。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/components/CompactCat.vue` | Live2D、键位叠图、导入皮肤、计数框、菜单和动作层级 |
| `src/pages/main/index.vue` | 主窗口尺寸、缩放、拖动、点击和全局输入入口 |
| `src/composables/useStockPanel.ts` | 浮窗开关、自适应定位和显示器边界 |
| `src/pages/stock-panel/index.vue` | 行情/资讯模式、分组列表、详情图表、常驻、淡出和关闭交互 |
| `src/pages/stock-panel/NewsPanel.vue` | 资讯范围、主题、时间范围、召回档位、个股联动、结果列表和按需浮层 |
| `src/news/newsService.ts` | Gateway 资讯请求/响应类型与薄客户端 |
| `src/stores/news.ts` | 资讯筛选与本机已读状态 |
| `src/market/marketService.ts` | 内置/外接 Provider、报价、走势、日 K、搜索与缓存 |
| `src/stores/watchlist.ts` | 默认分组、8 组/50 只上限、迁移和淡出设置 |
| `src/stores/market.ts` | 行情源、外接地址、超时和持久化 Token |
| `src/stores/skin.ts` | 两套内置模型、导入皮肤和旧值迁移 |
| `src/skins/skinService.ts` | 前端皮肤导入、列举和删除接口 |
| `src-tauri/src/utils/skin.rs` | 皮肤 ZIP 安全校验、安装、列举和删除 |
| `src-tauri/src/utils/market.rs` | 受限外接 HTTP/HTTPS 请求 |
| `scripts/auditReleaseAssets.mjs` | 本地发行资产扫描 |
| `src-tauri/tauri.conf.json` | 窗口、安全策略、资源和打包目标 |

## 仓库与本地目录

- 本地项目：`C:\Users\Jason\Documents\BongoStock`；
- 远端：`origin = https://github.com/LAKiTU64/bongostock.git`；
- `main` 跟踪 `origin/main`；
- `.gitignore` 排除 `node_modules/`、`dist/`、`target/`、ZIP、`.bongoskin`、凭据和本地快照；
- 项目外个人皮肤与 `C:\Users\Jason\Apps\BongoStock` 的手工部署目录不属于仓库。

## 验证

常规验证：

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm run build:vite
cargo check --locked
pnpm run audit:release
```

运行完整应用：

```bash
pnpm tauri dev
```

当前已有两项 Rust 单元测试，覆盖 Windows ZIP 分隔符标准化和父目录穿越拒绝。无需建立复杂测试体系；核心数据迁移或安全边界变化时再补针对性测试。

## 平台状态

### Windows

- 本机 Node、pnpm、Rust MSVC、WebView2 和 Visual Studio Build Tools 已可用；
- Debug 构建与手工部署链路已验证；
- Tauri 已配置 NSIS `.exe` 安装包，但当前不发布。

### macOS

- 工程保留 macOS 权限与 DMG/App 配置；
- 全局输入需要 Input Monitoring；
- 最新模型、图表、资讯浮窗、字体、缩放和透明窗口改动仍需轻量实机回归；
- DMG 对外分发前需要签名与公证。

Windows/macOS 从源码运行、打包、权限和外接行情配置见 [`CLIENT_DEPLOYMENT.md`](CLIENT_DEPLOYMENT.md)。

## 下一步

1. 继续日常使用并修复可复现问题；
2. 完成 macOS 轻量回归；
3. 保持 README、产品方案、资讯设计和接续文档同步；
4. 面向他人分发前确认内置模型再分发条款，并处理签名、公证和安装包；
5. 不主动增加后台轮询、自动交易、周 K/月 K、提醒、AI 或 MCP。

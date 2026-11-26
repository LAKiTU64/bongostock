# BongoStock

BongoStock 是一款供个人使用的 Windows/macOS 紧凑桌宠。它记录键盘按下和鼠标点击次数、响应输入动作，并在用户主动点击桌宠时打开行情/资讯浮窗。

- 当前版本：`1.1.0`
- 当前阶段：`1.1.0` 已发布（自选云端双向同步 v2 + 分组重排）；资讯中心 Phase 0～6 已实现
- 公开仓库：<https://github.com/LAKiTU64/bongostock>
- 默认分支：`main`
- 软件包状态：`1.1.0` 的 Windows x64 NSIS 安装包与 macOS Apple Silicon DMG 已通过 [GitHub Release 1.1.0](https://github.com/LAKiTU64/bongostock/releases/tag/1.1.0) 发布；当前构建未进行代码签名/公证
- 变更记录：见 [CHANGELOG.md](CHANGELOG.md)

## 当前功能

### 桌宠

- 键盘按下和鼠标点击累计计数，计数保存在本机；
- 鼠标、键盘和左右猫爪动作反馈；
- 透明、无边框、可拖动、可置顶窗口；
- 托盘、窗口穿透、透明度、保持在屏幕内和开机自启动；
- 托盘和桌宠右键菜单提供「找回桌宠与浮窗」：将桌宠与已有浮窗移到鼠标所在显示器的工作区，无法确定时使用主屏。显示桌宠并保持原有置顶、缩放、透明度和穿透设置；已显示的浮窗保持显示，隐藏或未打开的浮窗不会被打开，也不会自动恢复视频播放或声音；
- 启动及显示器变化后的定位会检查整个窗口是否在工作区内；首次升级会重置缺少显示器缩放信息的旧 macOS 位置记录。再次打开正在运行的应用也可找回桌宠，无需先打开设置；
- 桌宠尺寸可在 50%～300% 之间连续调节；
- 计数框按最多 9 位数 `999 999 999` 设计；
- Windows 提供管理员权限说明和“不再提示管理员权限”开关。

### 模型与皮肤

公开仓库内置两套 MMmmmoko 模型，均使用与 [Awesome-BongoCat](https://github.com/ayangweb/Awesome-BongoCat) 兼容的 Live2D 目录结构：

- `builtin:mmmmmoko`：`经典小键盘 · 标准模式`，包含鼠标垫、键盘、鼠标反馈和标准模式键位图层；
- `builtin:mmmmmoko-keyboard`：`经典小键盘 · 键盘模式`，包含左右爪与键位图层。

内置模型复用原版 BongoCat 的背景、Live2D 和键位叠图坐标体系；同一只爪同时只显示最后按下的一个键位反馈。BongoStock 自己的计数框和 SVG 菜单框保持在模型下方。

自定义外观通过本地 `.bongoskin`/ZIP 包导入，当前支持 `layered-png-v1`：左右爪各有静止和拍下图层。导入器限制压缩包大小、文件数量、单文件大小和路径，并拒绝目录穿越与可执行内容。

项目外私人皮肤不在本仓库、不在内置资源、不在 Git 历史中，也不会进入公开构建。未取得明确再分发许可前不得上传或打包。

### 自选行情

- 点击桌宠打开独立行情浮窗；
- 首次打开或临时状态回收后按桌宠当前位置重新定位，优先显示在下方，空间不足时显示在上方；
- 浮窗顶栏提供专用拖拽手柄；点击外部区域关闭后默认保留状态和拖拽位置30秒，期间切换行情/资讯或重新打开不会改变位置；保留时间可在行情设置中调整，`Esc` 始终可以关闭并清除临时状态；
- 常驻按钮按“普通 → 置顶（保留无操作淡出）→ 置顶且不透明（禁用淡出，背景与内容均完全不透明）→ 普通”循环切换；普通模式点击外部区域会关闭浮窗，两种置顶模式均保持浮窗打开，`Esc` 始终可以关闭；每次重新打开均重置为普通模式；
- 最多 8 个分组，全部分组合计最多 300 只沪深股票、指数或场内基金；同一只证券可以同时加入多个分组，按去重后的数量计入上限；
- 列表采用紧凑双栏布局；
- 支持 `SH600036`、`SZ000858` 和 6 位纯数字代码；
- 纯数字代码按沪深规则补齐交易所，并在线匹配证券名称；
- 新数据默认建立“自选股”分组，包含上证指数、深证成指、沪深 300、科创 50；
- 默认无操作 2 秒后淡出至 28% 不透明度；等待时间和淡出程度均可调；
- 打开浮窗或手动刷新时请求一次报价，浮窗关闭时不轮询；
- 点击证券后按需加载分时、5 日和日 K；
- 图表悬停显示对应时间/日期与价格，日 K 同时显示开、高、低、收；
- **自选分组与云端双向同步（v2）**：云端为权威源，本地为派生缓存。采用时间戳增量拉取（行情请求顺带检查）+ 2 秒防抖推送 + `baseUpdatedAt` 乐观锁，多终端冲突时返回 409 并自动重拉；云端为空而本地有数据时自动推送本地（首次迁移无痛）；
- **分组/组内股票重排**：客户端设置页与 Web 管理页均支持 ↑↓/拖拽重排，顺序由云端持久化，两端自动同步；
- **云端备份/回滚**：每次写入自动快照（最多 10 份），可通过 Web 管理页或 API 一键回滚，回滚结果自动同步到客户端。

## 行情数据源

BongoStock 不再内置任何本地行情数据源。报价、搜索、分时/5 日和日 K 全部来自外接的 BongoStock API v1（云端服务）：

- 报价：`POST /v1/quotes`，每批最多 25 个代码；
- 搜索：`POST /v1/search`；
- 分时/5 日：`POST /v1/trends`；
- 日 K：`POST /v1/klines`（前复权）。

设置页支持 HTTP/HTTPS、Bearer Token 和 1～30 秒超时。正式构建将 Token 存入系统凭据库；开发模式保存在本机配置文件中，避免重编译后反复请求钥匙串授权。正式版迁移旧配置时，先确认系统凭据写入成功，再清除旧字段；失败时保留原配置。请勿分享或提交本地配置文件。未配置可用服务时，行情功能不可用。

外接服务需要实现：

```text
GET  /v1/capabilities
POST /v1/quotes
POST /v1/search
POST /v1/trends
POST /v1/klines
```

这些数据只用于个人辅助参考，不能替代券商终端。

资讯中心额外使用 Gateway 的 `POST /v1/news/search`。只要已配置可用的 Gateway 地址和 Bearer Token，资讯即可通过 Gateway 使用。

完整请求与响应约定见 [`docs/EXTERNAL_MARKET_API_V1.md`](docs/EXTERNAL_MARKET_API_V1.md)。证券代码放在 POST body 中只能减少 URL/访问日志暴露；HTTP 仍是明文，HTTPS 也不能隐藏外接服务器自身看到的代码。

## 资讯中心

- 提供全市场、简报和个股三个范围；个股范围联动本地自选分组与证券；
- 使用内置主题，也可右击搜索按钮临时输入完整检索词；不保存搜索历史或检索词收藏；
- 提供 1 天、3 天、7 天和不限四档时间范围，按发布时间倒序展示，并提供约 10 条和约 20 条两个召回档位；
- 只在用户点击搜索或顶部刷新时请求，不后台轮询；
- 数据仅由 BongoStock Gateway 转发，客户端不直连上游资讯服务、不保存上游 API Key，也不提供本地资讯回退；
- 新闻列表保持紧凑；点击条目进入同一浮窗内的完整内容页，可返回列表或通过系统浏览器打开原文，已读条目在本机淡化显示。

## 刷视频

- 行情浮窗的「刷视频」页提供推荐、每周必看、排行和关注四个来源，支持滚动加载或手动加载更多；不提供视频搜索；
- 列表、封面、扫码登录和视频字节流全部经过已配置的 Gateway；JSON 请求通过 Tauri 请求通道发送，客户端不保存 B 站 Cookie；
- 设置的「行情」页可扫码登录、查询状态、切换账号或退出。登录凭据保存在网关，连接同一网关的客户端共用一个 B 站账号；
- 未登录可查看游客推荐、每周必看和排行，关注视频需要登录。上游排行不可用时，会明确提示正在显示热门视频；
- 点击卡片在浮窗内播放；仅在确认当前输出为耳机且设备监听正常时默认开启声音，扬声器、未知输出或查询失败时默认静音。仍可手动静音或开启声音（包括扬声器）；开启声音前会重新确认音频输出，查询失败时保持静音。只提供播放/暂停、静音/开启声音、进度条、倍速和返回列表，不提供全屏、画中画或音量滑块。标题和控制条覆盖在视频上，鼠标移入时显示、移出时隐藏；键盘操作或展开选集时保持可见。点击倍速数字按 1× → 1.5× → 2× → 0.75× → 1× 轮换，切换分 P 时保留当前倍速。多 P 视频额外提供选集入口，播放完一 P 后停止，不自动播放下一 P；
- macOS 可能请求蓝牙权限，用于确认当前蓝牙输出是否为耳机；不扫描、配对或主动连接设备。拒绝权限或无法确认设备类型时保持静音。系统音频路由通知是异步的，这一保护不保证硬件切换过程中的零漏音；
- 音频输出变化时立即静音并暂停，保留播放位置；重新接上耳机不会自动恢复播放或声音，需手动操作。切 P 复用当前声音意图，但每次播放前重新检查输出；无法建立设备监听时禁用默认开声，仍可明确手动开启；
- 「历史」与四个视频来源位于同一栏，仅显示 B 站云端账号历史，按观看时间选择每个视频最近观看的分 P。列表只缓存在内存，读取失败保留已加载的云端条目并提供重试；未登录时引导登录，网关不支持账号身份时明确提示更新，不回退到本地记录；
- 续播只使用云端返回的同视频、同一 P 进度，并用播放器的实际 P 时长校验，不用云端视频总时长。已看完或距离结尾不足 5 秒（短视频不足时长的 5%）时从头播放。进入历史页或从播放器返回时重新读取云端记录；
- 登录后的实际播放约每 15 秒通过网关上报进度，暂停、切 P、结束时尽力补报；上报不阻塞播放，失败退避、不重发旧快照。实际观看时长只累计 playing 状态的墙钟时间，不计暂停、缓冲和 seek，也不按倍速放大。断网、异常退出或上游同步延迟时，最后一段进度可能无法恢复；
- 客户端不再读取、写入或合并本地观看记录，也不提供本地记录入口及删除、清空操作。旧版已存文件保持原样，不主动删除或上传；云端账号历史没有删除操作；
- 换账号、重登、改网关或令牌会停止旧播放、清掉临时账号缓存并撤销旧上报队列。账号接口基于社区资料而非官方稳定开放 API，跨设备同步效果仍取决于上游服务；
- 视频封面底部左侧显示播放量、右侧显示时长；播放量使用 `123`、`2345`、`1.1w`、`108w` 等简写，不另占文字行。无播放量的历史条目不显示该标签，分 P 观看位置仍单独显示；
- 返回列表、切换页面或关闭浮窗时停止播放；重新打开浮窗不会自动播放出声，需主动选择视频。播放器留白和滚动条沿用浮窗主题；
- 实际视频和画质取决于上游可用性及账号权限；二维码过期或登录失效后需重新扫码。

## 技术栈

- Tauri 2
- Vue 3、TypeScript、Pinia
- Rust stable
- Vite
- PixiJS、easy-live2d

## 本地开发

需要 Node.js、pnpm、Rust stable，以及目标平台的 Tauri 构建依赖。

从空机器安装依赖、运行、打包和连接外接网关的完整步骤见 [`docs/CLIENT_DEPLOYMENT.md`](docs/CLIENT_DEPLOYMENT.md)。

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

需要 WebView2、Microsoft C++ Build Tools 和 `stable-x86_64-pc-windows-msvc`。`1.1.0` 的 Windows x64 NSIS 安装包已通过 [GitHub Release 1.1.0](https://github.com/LAKiTU64/bongostock/releases/tag/1.1.0) 发布；本地构建命令为：

```powershell
pnpm tauri build --bundles nsis
```

### macOS

需要 Apple Command Line Tools；捕获全局输入需要「输入监控」和「辅助功能」两项权限。Apple Silicon DMG 本地构建已经验证，DMG 必须在 macOS 上构建：

```bash
pnpm tauri build --bundles dmg
```

调试构建请使用：

```bash
pnpm mac:build-debug
```

它在打包后为 `.app` 附加固定的 ad-hoc 签名身份。未签名构建的 designated requirement 是每次编译都变化的 cdhash，macOS 会把它当成另一个程序，导致每次重新构建都要重新授权「输入监控」和「辅助功能」。

对外分发仍需 Apple Developer 签名与公证。

## 发布安全

发布或打包前执行：

```bash
pnpm run audit:release
```

`.gitignore` 已排除 `*.bongoskin`、ZIP、本地快照、依赖和构建产物。发布审计和 Git 忽略规则是辅助防线，不能替代人工确认第三方模型授权。

## 文档

- 资讯中心实现基线：[`docs/NEWS_CENTER_DESIGN.md`](docs/NEWS_CENTER_DESIGN.md)
- 项目接续总览：[`docs/PROJECT_HANDOFF.md`](docs/PROJECT_HANDOFF.md)
- 产品与技术方案：[`docs/BongoStock_Product_Spec_v0.1.md`](docs/BongoStock_Product_Spec_v0.1.md)
- Phase 6 行情功能历史快照：[`docs/PHASE_6_BASELINE.md`](docs/PHASE_6_BASELINE.md)
- 外接行情协议：[`docs/EXTERNAL_MARKET_API_V1.md`](docs/EXTERNAL_MARKET_API_V1.md)
- 新设备接续提示：[`HANDOFF_PROMPT.md`](HANDOFF_PROMPT.md)
- 设备迁移/克隆清单：[`docs/DEVICE_TRANSFER_CHECKLIST.md`](docs/DEVICE_TRANSFER_CHECKLIST.md)
- Windows/macOS 客户端部署：[`docs/CLIENT_DEPLOYMENT.md`](docs/CLIENT_DEPLOYMENT.md)
- Phase 0～6：历史实施快照，不代表当前功能上限

## 素材与署名

- 跨平台工程底座来自 [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat)，遵循其 MIT License；
- 内置模型来源链指向 [MMmmmoko/Bongo-Cat-Mver](https://github.com/MMmmmoko/Bongo-Cat-Mver)，模型索引与包格式参考 [ayangweb/Awesome-BongoCat](https://github.com/ayangweb/Awesome-BongoCat)；
- 行情模块由用户配置的 BongoStock API v1 云端服务提供数据，客户端不内置任何行情数据源。

完整声明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

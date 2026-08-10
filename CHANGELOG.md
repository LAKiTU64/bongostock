# 更新日志

本文件记录已发布版本之间的用户可见变化。日期使用本地时区。

## 1.0.1 — 2026-08-10

本版全部为 macOS 修复，Windows 行为未改动。Windows x64 NSIS 安装包与 macOS Apple Silicon DMG 已通过 [GitHub Release v1.0.1](https://github.com/LAKiTU64/bongostock/releases/tag/v1.0.1) 发布。

### 新增

- **行情浮窗打开时自动刷新。** 列表页每 5 秒刷新当前分组的股票，个股详情页每 3 秒只刷新该股票，两者互斥；浮窗关闭、切到资讯标签或非交易时段都不发请求。刷新间隔带 ±10% 抖动。详情页只重新拉取当前标签页所需的那一条序列，不再连带拉取另外两条。自动刷新失败时保留上一次数据，不打断看盘，也不重置浮窗的淡出计时。

### 变更

- **同一只证券可以同时加入多个分组。** 原先全局唯一，一只股票只能属于一个分组。上限 50 改为按去重后的证券数计算：一只股票加进三个分组仍然只占一个名额，行情也只请求一次。同一分组内仍然不允许重复。

### 修复

- **切换分组后不加载行情。** 切换只更新了当前分组 ID，没有触发请求，新分组的股票全部显示为「等待行情」，必须手动点刷新。收盘后尤其明显——自动刷新只在交易时段运行，光等永远等不到。现在切换分组会立即拉取该分组的行情，并重排自动刷新节奏。
- **分时与 5 日曲线的横轴比例错误。** 曲线的 X 坐标按数据点序号等分画布宽度，最后一个点永远落在画布最右端。结果是任何未走完的交易日都会被拉伸铺满全宽：14:18 打开时，曲线一路画到 15:00 的位置，时间刻度与实际时间完全对不上。现改为按交易时钟定位（09:30–11:30 与 13:00–15:00 共 240 分钟，5 日图为 5 × 240），未到的时间留空；11:30/13:00 分界线也改由时间计算，不再由数据点位置反推。悬浮取值改为匹配每个点实际绘制的 X 坐标。
- **键鼠计数在 macOS 上完全失效。** 应用申请「输入监控」权限时调用的是第三方插件 `tauri-plugin-macos-permissions` 的 `request_input_monitoring_permission()`，而该实现只执行 `open x-apple.systempreferences:...Privacy_ListenEvent` 打开设置面板，从不调用 `IOHIDRequestAccess`。macOS 只有在应用真正发起该请求后才会把它登记进「输入监控」列表，因此 BongoStock 从未出现在列表中，用户无从授权，`rdev` 也就收不到任何全局事件。现改为由自有命令 `request_input_monitoring_access` 直接调用 IOKit 的 `IOHIDRequestAccess`，插件的打开面板行为退化为兜底。
- **权限申请每轮只处理一项。** 缺失辅助功能时永远优先申请辅助功能，输入监控要等到辅助功能授权后才轮得到。现在两项分别判断、各自只申请一次。
- **监听启动失败后无法重试。** 全局标志在监听器真正启动前就被置为「已启动」，任何一次初始化失败都会让后续重试被直接跳过。现改为失败时解除标志，并在窗口重新获得焦点时自动重试。
- **外接服务地址无法编辑。** 输入框每敲一次键就写入 store 并广播设置变更事件，而本窗口自身也监听该事件并对地址执行归一化；归一化把任何解析失败的中间态（如退格产生的 `https:/`）替换为默认地址，导致地址框在编辑过程中被反复重填、无法删除。现改为编辑期间只更新本地草稿，失焦或回车时才提交；归一化也不再把解析失败当作重置理由，只有空值和非 HTTP(S) 协议才回落默认值。
- **桌宠窗口可被拖拽缩放。** 配置中已声明 `resizable: false`，但 macOS 侧 NSPanel 初始化又显式加回了 `resizable` 样式，缩放后画面下半部分被裁切。已移除该样式。
- **行情浮窗首次打开失败。** 首个显示事件可能早于前端监听器注册。现改为由浮窗页面挂载完成后主动通知就绪。
- **计数字体在 macOS 上偏小。** 相对高度由约 33% 调整到约 39%，与 Windows 观感对齐；Windows 字号未变。

### 构建

- 新增 `scripts/signMacDebug.ts` 与 `pnpm mac:build-debug`：给本地调试包打上固定的 ad-hoc 签名身份（identifier `com.bongostock.desktop`，designated requirement 锁定该 identifier）。未签名构建的 designated requirement 是每次编译都变化的 cdhash，macOS 会视其为不同程序，导致每次重新构建都要重新授权 TCC 权限。
- 原脚本名 `build:mac-debug` 落在 `"build": "run-s build:*"` 的通配范围内，而 `tauri.conf.json` 的 `beforeBuildCommand` 正是 `pnpm build`，会导致 `tauri build` 递归触发自身。已改名为 `mac:build-debug`。
- 新增 `scripts/checkDocs.mjs` 与 `pnpm check:docs`：校验版本号、文档中引用的 pnpm 脚本名、默认服务地址在代码与文档之间保持一致。

## 1.0.0 — 2026-08-09

首个正式版本。Windows/macOS 桌宠，键鼠计数与 Live2D 动作反馈；自选分组、实时报价、分时、5 日与日 K；紧凑资讯中心与资讯详情页；可对接自建 BongoStock Gateway。

Windows x64 NSIS 安装包已通过 [GitHub Release v1.0.0](https://github.com/LAKiTU64/bongostock/releases/tag/v1.0.0) 发布。

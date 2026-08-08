# 新设备 Codex 接续提示

将 BongoStock 源代码复制到新设备后，把下面内容交给 Codex：

```text
你现在接手我的 BongoStock 个人桌宠项目。请先完整阅读：

1. README.md
2. docs/PROJECT_HANDOFF.md
3. docs/PHASE_5_BASELINE.md
4. docs/BongoStock_Product_Spec_v0.1.md
5. THIRD_PARTY_NOTICES.md
6. docs/DEVICE_TRANSFER_CHECKLIST.md

Phase 0～4 文档是历史实施记录；当前行为以上述文件和实际代码为准。读取文档后必须检查代码，不能只凭文档猜测。

当前状态：

- 个人使用 Alpha，主要功能已完成，安装包暂不处理；
- 记录键盘和鼠标点击次数，支持拍爪、拖动、托盘和本地持久化；
- 默认只内置 MMmmmoko；其他皮肤通过项目外 `.bongoskin` 包导入；
- 内部 github/steam 标识只用于兼容已有设置，新内置值为 `builtin:mmmmmoko`；
- StrayRogue 对应的本机游戏素材仅供个人本地使用，不得上传公开仓库或打入发行包；
- 桌宠尺寸支持 50%～300%；
- 行情最多 8 个分组、总计 50 只股票或基金；新设备默认“自选股”包含四个指数；
- 行情源可选内置 stock-api 或外接 BongoStock API v1，外接支持 HTTP/HTTPS；
- 支持 SH/SZ 完整代码和 6 位纯数字代码，并在线匹配名称；
- 行情浮窗为双栏，可拖动、淡出、临时常驻；每次打开时自动生成在桌宠附近；
- 行情只在打开或手动刷新时请求，不后台轮询；
- Windows 管理员权限提示可以关闭；
- 不需要复杂自动化测试；修改核心数据规则时才考虑少量单元测试；
- 不做自动交易、K 线、提醒、AI、MCP 或安装包，除非我明确提出；
- 不执行 git init、commit、push、tag 或发布，除非我在当前任务明确授权。

新设备不要复用其他系统生成的 node_modules、dist 或 target。使用锁文件重新安装并执行：

pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm run build:vite
cargo check --locked
pnpm tauri dev

请用中文沟通，保持项目简单，以真实使用问题为优先，不要自行扩展需求。
```

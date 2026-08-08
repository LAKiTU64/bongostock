# 设备迁移清单

## 迁移范围

BongoStock 的公开源码通过 GitHub 迁移；个人设置、计数、自选股和导入皮肤按需在个人设备之间单独迁移。不要把两类内容混进同一个压缩包或提交。

公开仓库：<https://github.com/LAKiTU64/bongostock>

## 1. 在新设备获取源码

```powershell
git clone https://github.com/LAKiTU64/bongostock.git
cd bongostock
corepack enable
pnpm install --frozen-lockfile
```

macOS/Linux 将 PowerShell 命令换成对应终端即可。Node.js、pnpm、Rust、平台编译工具和 Tauri 系统依赖见根目录 [README](../README.md)。

不需要迁移：

- `node_modules/`
- `target/`
- `dist/`
- `src-tauri/target/`
- 日志、崩溃转储和临时文件
- NSIS、DMG 等安装产物
- 任何凭据、Token 或公司环境信息

## 2. 可选：迁移个人应用数据

只有确实需要保留下列内容时才迁移本地应用数据：

- 累计点击/按键计数；
- 窗口、透明度、淡出、快捷键等偏好；
- 自选分组与证券列表；
- 已导入的本地 `.bongoskin` 皮肤。

操作原则：

1. 两台设备都退出 BongoStock；
2. 在旧设备上找到 Bundle Identifier `com.bongostock.desktop` 对应的应用数据目录；
3. 先做一份私下备份，再复制到新设备的相应目录；
4. 启动应用，核对计数、设置、自选组和皮肤；
5. 若数据格式不兼容，删除新设备上的复制件并让应用重新初始化。

Windows 通常位于用户的 `AppData` 范围，macOS 通常位于用户 `Library` 范围；实际路径以当前 Tauri Store 和应用日志显示为准，不要把绝对用户路径写入仓库。

## 3. 私人皮肤边界

- 公开仓库只内置 MMmmmoko 标准模式和键盘模式；
- StrayRogue/Steam 素材不在源码、Git 历史或公开构建中；
- 含这类素材的 `.bongoskin`/ZIP 只能在个人设备之间私下迁移；
- 不要上传到 GitHub、Release、网盘公开链接或 issue 附件；
- 导入皮肤前检查来源、授权和 `NOTICE.txt`。

## 4. 新设备验证

```powershell
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm run build:vite
pnpm run audit:release
Push-Location src-tauri
cargo test --locked
Pop-Location
pnpm tauri dev
```

手动核对：

- 两套内置 MMmmmoko 模型均可显示；
- 鼠标和键盘动作位置正确；
- 计数框、SVG 菜单框和窗口缩放正常；
- 默认“自选股”含四个指数；
- 分时、5 日、日 K 可打开并显示悬停价格；
- 外接行情的 HTTP/HTTPS、超时和临时 Token 行为符合预期；
- Windows 全局输入权限提示正常；macOS 在真机授权后回归输入监听。

## 5. Git 安全检查

提交前执行：

```powershell
git status --short
git diff --check
git ls-files | Select-String -Pattern 'stray|steam-bongocat|\.bongoskin$|\.zip$' -CaseSensitive:$false
```

最后一条正常情况下不应返回私人皮肤资产。仅在用户明确要求发布当前改动时才推送远端。

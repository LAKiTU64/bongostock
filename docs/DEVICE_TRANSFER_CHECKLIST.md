# 设备迁移清单

## 目标

在不依赖版本管理工具的情况下，将 BongoStock 的完整可编辑源代码从当前设备迁移到个人设备，同时避免携带构建缓存、日志、凭据和单位信息。

## 迁移前检查

1. 确认单位允许将个人项目源代码从单位设备带出。
2. 确认项目没有包含单位代码、内部文档、内部域名、证书、账号、数据或素材。
3. 搜索 `.env`、密钥、Token、Cookie、证书、代理地址和内部 URL。
4. 确认 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和产品文档存在。
5. 记录当前 Node、pnpm、Rust 和系统版本。

## 应迁移的内容

- `src/`
- `src-tauri/`
- `public/`
- `scripts/`
- `docs/`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `Cargo.toml`
- `Cargo.lock`
- TypeScript、Vite、ESLint 和 UnoCSS 配置
- `README.md`
- `LICENSE`
- `THIRD_PARTY_NOTICES.md`

## 不迁移的内容

- `node_modules/`
- `dist/`
- `target/`
- 应用日志
- 系统钥匙串内容
- `.env` 和本机凭据
- 编辑器缓存
- 临时文件
- 安装包和编译产物

## 推荐迁移方式

在获得单位许可后，将项目目录复制到一个新的临时目录，排除构建产物和敏感文件，再创建加密归档。归档密码通过独立渠道保存，并为归档计算 SHA-256；个人设备收到文件后先校验 SHA-256。

个人设备收到归档后：

1. 解压到个人开发目录；
2. 重新安装 Node、pnpm 和 Rust；
3. 执行 `pnpm install --frozen-lockfile`；
4. 执行 `pnpm build`；
5. 执行 `cargo check --locked`；
6. 执行 `pnpm tauri dev`；
7. 检查桌宠、托盘、设置和快捷键；
8. macOS 重新授权 Input Monitoring；
9. 完成敏感信息扫描后，再决定是否建立版本管理或发布到 GitHub。

`node_modules/`、`dist/` 和 `target/` 不能跨设备或跨操作系统复用。当前可迁移源文件约 7.3 MB，本机构建缓存约 5.3 GB。

个人设备为 Windows 时，根据 Tauri 官方前置要求安装 Microsoft C++ Build Tools、WebView2 和 stable MSVC Rust toolchain：<https://v2.tauri.app/start/prerequisites/>。

## GitHub 发布前

1. 先确认劳动合同、知识产权归属、保密协议、可接受使用政策和开源贡献政策。
2. 单位未明确允许时，不要从单位设备向个人 GitHub 上传，即使仓库设置为 Private。
3. 使用个人设备和个人账号建立仓库。
4. 初次上传前扫描全部历史和文件内容，确认不存在单位信息或凭据。
5. 保留 BongoCat MIT License 与第三方声明。
6. 为个人 GitHub 账号启用双因素认证，并使用独立的个人 SSH 密钥或细粒度 Token。

Private 仓库仍然属于向外部平台上传。单位未明确允许时，不以 Private 作为绕过单位审批的方式。

GitHub 安全参考：

- 仓库可见性：<https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility>
- Push Protection：<https://docs.github.com/en/code-security/concepts/secret-security/push-protection>
- 双因素认证：<https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/about-two-factor-authentication>
- SSH 密钥：<https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account>
- Personal Access Token：<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>

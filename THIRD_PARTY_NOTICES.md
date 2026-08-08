# Third-Party Notices

本文件说明 BongoStock 源码仓库和本地皮肤功能涉及的第三方项目与素材边界。公开仓库：<https://github.com/LAKiTU64/bongostock>。

## BongoCat

- Project: <https://github.com/ayangweb/BongoCat>
- Author: ayangweb
- License: MIT

BongoStock 的桌宠实现、模型目录兼容和交互方式参考了 BongoCat。BongoCat 的许可证文本及署名要求以其上游仓库为准。

## MMmmmoko / Awesome-BongoCat

- Model repository: <https://github.com/ayangweb/Awesome-BongoCat>
- Illustrated/model assets credited to: MMmmmoko

当前公开仓库内置两种 UI 可选模式：

- `builtin:mmmmmoko`：经典小键盘 · 标准模式；
- `builtin:mmmmmoko-keyboard`：经典小键盘 · 键盘模式。

这些模型采用 Awesome-BongoCat 兼容目录，包含运行所需的背景、Live2D、键位图层和预览资源。上游仓库中其他模型不会因为目录存在而自动成为 BongoStock 的内置 UI 选项。

第三方模型可能采用不同许可证或附带单独说明。重新分发、修改或打包前，应核对对应模型目录、上游页面和附带声明；本文件不替代原作者授权。

## StrayRogue / Steam Bongo Cat 素材

StrayRogue/Steam 风格素材不属于 BongoStock 公开发布内容：

- 不在当前源码树中；
- 不在 Git 历史中；
- 不在公开构建或安装产物中；
- 不通过本仓库提供下载。

BongoStock 只提供通用的本地 `.bongoskin`/ZIP 导入机制。用户自行导入的皮肤保存在本机，其素材来源与使用授权由导入者负责。即使是非商业、学习用途，也不等同于获得公开再分发许可。

## 行情数据与第三方接口

内置行情会访问第三方公开行情接口；外接模式则访问用户配置的 HTTP/HTTPS 服务。数据接口、字段、可用性和许可可能变化，使用者应遵守数据提供方条款。BongoStock 不保证行情的完整性、实时性或交易适用性。

## 应用依赖

JavaScript、Rust 和系统依赖的完整版本以 `pnpm-lock.yaml`、`src-tauri/Cargo.lock` 和各依赖自带许可证为准。发布构建前应运行许可证与资产审计，并保留适用的第三方声明。

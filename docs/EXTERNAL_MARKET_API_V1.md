# BongoStock 外接行情协议 v1

外接行情服务是用户自建或信任的第三方服务，也是桌面端唯一的行情数据来源（客户端不内置任何本地行情源）。

## 连接设置

- Base URL：仅支持 `http://` 或 `https://`；默认示例为 `https://127.0.0.1:8443`；
- Timeout：1,000～30,000 ms，默认 8,000 ms；
- Bearer Token：可选，保存在本机应用数据中，应用重启后自动恢复。

推荐生产或跨设备连接使用 HTTPS。HTTP 适合本机、可信局域网或明确接受明文风险的环境。

## 安全约束

Rust 请求层执行以下限制：

- 只允许 `GET` 和 `POST`；
- 请求的 scheme 与 host 必须和配置的 Base URL 一致；
- 路径必须位于 `/v1/` 下；
- 禁止自动跟随重定向；
- 单次响应最大 2 MiB；
- 超时采用设置值；
- Token 只通过 `Authorization: Bearer <token>` 发送给已配置主机。Token 会以明文存在本机应用数据文件中，请勿提交、上传或分享该文件。

这些限制降低误发和重定向泄露风险，但服务端、网络管理员或 TLS 终端仍可能看到目标主机、访问时间、流量大小；使用 HTTP 时还可能直接看到路径、参数、证券代码和返回内容。

## 接口

### `GET /v1/capabilities`

返回服务能力。当前桌面端允许任意 JSON 对象，并将其用于连接测试或能力展示。

```json
{
  "protocol": "bongostock-market-v1",
  "quotes": true,
  "search": true,
  "trends": ["intraday", "five-day"],
  "klines": ["day"]
}
```

### `POST /v1/quotes`

请求：

```json
{ "codes": ["SH000001", "SZ399001"] }
```

响应可直接返回数组，也可包装为 `{ "quotes": [...] }`：

```json
{
  "quotes": [
    {
      "code": "SH000001",
      "name": "上证指数",
      "price": 3600.12,
      "changePercent": 0.35,
      "updatedAt": "2026-08-08T03:30:00.000Z"
    }
  ]
}
```

### `POST /v1/search`

请求：

```json
{ "query": "588170" }
```

响应可直接返回数组，也可包装为 `{ "candidates": [...] }`：

```json
{
  "candidates": [
    { "code": "SH588170", "name": "示例基金", "market": "SH" }
  ]
}
```

### `POST /v1/trends`

请求中的 `days` 只使用 `1` 或 `5`：

```json
{ "code": "SH000001", "days": 1 }
```

响应可直接返回趋势对象，也可包装为 `{ "data": { ... } }`：

```json
{
  "code": "SH000001",
  "name": "上证指数",
  "preClose": 3587.66,
  "points": [
    {
      "timestamp": "2026-08-08 09:30",
      "date": "2026-08-08",
      "time": "09:30",
      "open": 3592.18,
      "close": 3592.18,
      "high": 3592.18,
      "low": 3592.18,
      "volume": 123456,
      "amount": 456789000,
      "average": 3592.18
    }
  ]
}
```

响应也可包装为 `{ "data": { ... } }`。`days=5` 使用同一结构，`points` 跨越最近五个交易日。

### `POST /v1/klines`

请求：

```json
{ "code": "SH000001", "period": "day", "count": 30 }
```

响应可直接返回数组，也可包装为 `{ "klines": [...] }`：

```json
{
  "klines": [
    {
      "date": "2026-08-08",
      "open": 3588.1,
      "high": 3612.8,
      "low": 3579.2,
      "close": 3600.12,
      "volume": 123456789
    }
  ]
}
```

## 数据约定

- 证券代码使用 BongoStock 统一格式，例如 `SH000001`、`SZ399001`；
- 时间优先使用 ISO 8601；日 K 也可使用可解析的 `YYYY-MM-DD`；
- 数值字段应返回 JSON number，不要返回带单位的字符串；
- 报价涨跌字段可使用 `percent` 或 `changePercent`。桌面端内部以小数保存：推荐返回 `0.0035` 表示 `+0.35%`；为兼容常见服务，绝对值大于 1 的输入会自动除以 100；
- 不存在的数据应省略或返回 `null`，不要用无法区分的占位数；
- 服务端应保持证券代码与请求顺序可追踪，并为错误返回明确 HTTP 状态码。

## 最小部署建议

1. 只开放这五类 `/v1/` 路由；
2. 使用 HTTPS 和有效证书；
3. 对 Token 做最小权限、轮换和速率限制；
4. 不在日志中记录完整 Token；
5. v1 的证券代码位于 POST JSON 请求体，不在 URL 路径中；使用 HTTPS 时正文会被传输加密，但目标主机、连接时间和流量大小仍可被网络侧观察；
6. 对上游行情做短期缓存，避免桌面端并发造成不必要请求。

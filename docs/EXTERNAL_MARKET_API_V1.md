# BongoStock 外接行情协议 v1

外接行情服务是一个用户自建或可信第三方服务。桌面端只向设置中的主机发送 `/v1/` 请求，不会在外接模式下悄悄回退到内置源。

## 接口

```text
GET  /v1/capabilities
POST /v1/quotes
POST /v1/search
POST /v1/trends
POST /v1/klines
```

请求体：

```json
{ "codes": ["SH000001", "SZ399001"] }
```

```json
{ "query": "000001" }
```

```json
{ "code": "SH000001", "days": 1 }
```

```json
{ "code": "SH000001", "period": "day", "count": 30 }
```

## 响应

报价：

```json
{
  "quotes": [
    {
      "code": "SH000001",
      "name": "上证指数",
      "now": 3000.12,
      "low": 2988.01,
      "high": 3012.44,
      "percent": 0.01,
      "yesterday": 2970.42
    }
  ]
}
```

`percent` 使用小数，`0.01` 表示 1%。`/v1/search` 返回 `{ "candidates": [{ "code", "name" }] }`；趋势返回 `{ code, name, preClose, points }`；日 K 返回 `{ "klines": [{ date, open, close, high, low, volume }] }`。

## 部署和隐私

- 优先使用 HTTPS；HTTP 仅适合本机或受信任局域网。
- 服务端不要记录完整请求体、Bearer Token 或股票代码，除非用户明确需要审计。
- HTTPS 不能隐藏外接服务器自身看到的代码，也不能防止企业 TLS 检查或终端安全软件观察进程网络。
- 服务端应限制请求体大小、代码数量和请求频率，并校验代码格式。

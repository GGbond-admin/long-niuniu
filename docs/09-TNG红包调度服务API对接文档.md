# TNG 红包调度服务 API 对接文档

> 版本：v1.0  
> 日期：2026-08-19  
> 状态：联调协议，双方确认后按此实现  
> 适用对象：至尊牛牛后端、独立红包调度服务器开发者

## 1. 对接目标

手机端采集能力已经部署在独立服务器中。后续由：

- **游戏后端**作为 API 调用方；
- **红包调度服务器**作为 API 服务方；
- 手机端只与红包调度服务器交互，不再直接请求游戏后端。

本协议只包含两项核心能力：

1. 游戏后端提交金额、个数和随机红包 ID，请求创建 TNG 红包；
2. 游戏后端根据红包 ID 查询红包链接、状态及领取明细。

所有业务接口统一使用 **POST**，参数全部放在 JSON 请求体中，不使用 GET 或 URL 查询参数。

```text
游戏进入等待发包
  ↓
游戏后端生成 packetId
  ↓ POST /api/v1/packets/create
红包调度器持久化任务并控制手机创建 TNG 红包
  ↓
游戏后端轮询 POST /api/v1/packets/query
  ↓
拿到 shareUrl/deepLink 后在房间发布红包
  ↓
继续按 packetId 增量查询领取人、时间、金额
  ↓
游戏后端匹配玩家 KYC 并认额、结算
```

---

## 2. 基础约定

| 项目 | 约定 |
| --- | --- |
| Base URL | `https://<红包调度服务域名>` |
| 协议 | HTTPS，最低 TLS 1.2，必须校验证书 |
| 方法 | 所有接口均为 `POST` |
| Content-Type | `application/json; charset=utf-8` |
| 金额单位 | 马来西亚分（sen），使用 JSON 整数；`RM 1.01` = `101` |
| 时间 | ISO 8601 UTC，例如 `2026-08-19T07:03:00.123Z` |
| 字符编码 | UTF-8 |
| API 版本 | 路径版本 `/api/v1` |

禁止使用浮点金额，例如不得发送 `1.01`；必须发送 `101`。

### 2.1 红包 ID

`packetId` 由**游戏后端在调用创建接口前生成**，同时承担业务关联与幂等键作用。

生成规则：

```text
packetId = "pkt_" + 16 字节密码学安全随机数的 32 位小写十六进制
```

格式：

```regex
^pkt_[a-f0-9]{32}$
```

Node.js 示例：

```js
import { randomBytes } from 'node:crypto';

const packetId = `pkt_${randomBytes(16).toString('hex')}`;
```

示例：

```text
pkt_8f3c2a4d7e914df6b8a0c1e2f3456789
```

不得在 `packetId` 中编码玩家姓名、金额、手机号等业务或隐私信息。

---

## 3. API 鉴权与防重放

### 3.1 必须携带的请求头

每个请求都必须携带：

| 请求头 | 示例 | 说明 |
| --- | --- | --- |
| `X-TNG-Key-Id` | `tng-prod-2026-08-a` | 密钥编号，可公开，用于支持密钥轮换 |
| `X-TNG-Timestamp` | `1787132400000` | Unix 毫秒时间戳 |
| `X-TNG-Nonce` | UUID v4 | 每个请求唯一，重试也必须重新生成 |
| `X-TNG-Content-SHA256` | 64 位小写十六进制 | 请求体原始字节的 SHA-256 |
| `X-TNG-Signature` | 64 位小写十六进制 | HMAC-SHA256 签名 |

密钥 Secret 至少使用密码学安全随机生成的 **32 字节**，不得使用可读密码。

### 3.2 签名算法

先对实际发送的 JSON 原文计算哈希：

```text
contentHash = lowercase_hex(SHA256(rawBodyUtf8Bytes))
```

再按以下顺序拼接待签名字符串，每项之间只有一个换行符，结尾不加换行：

```text
TNG-HMAC-SHA256
<X-TNG-Timestamp>
<X-TNG-Nonce>
POST
<请求路径>
<X-TNG-Content-SHA256>
```

例如请求路径是：

```text
/api/v1/packets/create
```

签名计算：

```text
X-TNG-Signature = lowercase_hex(
  HMAC_SHA256(secret, canonicalRequest)
)
```

注意：

- 签名使用的是**实际发送的请求体原文**，签名后不得再次格式化或重排 JSON；
- 请求路径只包含 path，不包含域名；
- v1 不使用查询参数；
- 每次重试必须生成新的 `timestamp`、`nonce` 和 `signature`；
- 业务请求可以重试，业务幂等由 `packetId` 保证。

### 3.3 Node.js 签名参考实现

```js
import {
  createHash,
  createHmac,
  randomUUID,
} from 'node:crypto';

export function signRequest(path, payload, credentials) {
  const rawBody = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const nonce = randomUUID();
  const contentHash = createHash('sha256')
    .update(rawBody, 'utf8')
    .digest('hex');

  const canonicalRequest = [
    'TNG-HMAC-SHA256',
    timestamp,
    nonce,
    'POST',
    path,
    contentHash,
  ].join('\n');

  const signature = createHmac('sha256', credentials.secret)
    .update(canonicalRequest, 'utf8')
    .digest('hex');

  return {
    rawBody,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-TNG-Key-Id': credentials.keyId,
      'X-TNG-Timestamp': timestamp,
      'X-TNG-Nonce': nonce,
      'X-TNG-Content-SHA256': contentHash,
      'X-TNG-Signature': signature,
    },
  };
}
```

调用时必须直接发送 `rawBody`：

```js
const path = '/api/v1/packets/create';
const signed = signRequest(path, payload, credentials);

const response = await fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: signed.headers,
  body: signed.rawBody,
});
```

### 3.4 服务端验证要求

红包调度服务器必须按顺序执行：

1. 根据 `X-TNG-Key-Id` 找到密钥；
2. 检查密钥状态和有效期；
3. 校验时间戳与服务器时间偏差不超过 **300 秒**；
4. 使用 Redis 等原子存储执行 `SET NX`，检查同一 `keyId + nonce` 未被使用；
5. nonce 至少保留 **10 分钟**；
6. 用收到的原始请求体重新计算 `X-TNG-Content-SHA256`；
7. 重新计算 HMAC，并使用恒定时间比较；
8. 全部通过后才可以处理业务。

服务端必须同步 NTP。生产环境建议同时配置游戏后端出口 IP 白名单；如安全等级要求更高，可叠加 mTLS。

### 3.5 固定测试向量

以下数据只用于验证双方签名实现，不得用于生产：

```text
secret:
test_only_0123456789abcdef0123456789abcdef

timestamp:
1787132400000

nonce:
550e8400-e29b-41d4-a716-446655440000

path:
/api/v1/packets/create

rawBody:
{"packetId":"pkt_8f3c2a4d7e914df6b8a0c1e2f3456789","totalAmountCents":10120,"packetCount":124}

contentHash:
42e196fe24d77467bbcf9e9479eb886d8db8169ed4533561c35f756ba4cfe602

signature:
72bff807fb0a2c89559914e4ff97cb761aac7410af83d0bff8b86298ed557fbc
```

双方计算结果必须完全一致后才能进入业务联调。

---

## 4. 密钥更换机制

### 4.1 密钥数据模型

服务端至少保存：

```text
keyId
secret（使用 KMS 或主密钥加密保存）
status: ACTIVE | RETIRING | REVOKED
notBefore
notAfter
createdAt
```

同一环境必须允许**新旧两把密钥同时有效**。测试环境与生产环境不得共用密钥。

### 4.2 正常轮换流程

建议每 90 天轮换一次：

1. 服务方生成新的 `keyId + secret`；
2. 服务方先把新密钥设为 `ACTIVE`，旧密钥保持 `ACTIVE`；
3. 通过安全渠道一次性把新密钥交给游戏后端；
4. 游戏后端使用新密钥调用 `POST /api/v1/system/ping`；
5. 验证成功后，游戏后端切换所有请求到新 `keyId`；
6. 观察至少 24 小时，确认无旧密钥流量；
7. 旧密钥改为 `RETIRING`，再保留 24 小时回滚窗口；
8. 最后改为 `REVOKED`，立即拒绝后续请求。

推荐新旧密钥总重叠期为 **24–48 小时**。

### 4.3 紧急轮换

如怀疑 Secret 泄漏：

1. 立即创建并分发新密钥；
2. 游戏后端切换到新密钥；
3. 不等待重叠期，立即把旧密钥设为 `REVOKED`；
4. 审查旧 `keyId` 最近请求、IP、nonce 和红包创建记录。

密钥轮换通过安全运维渠道完成，**不提供公网“修改密钥”API**，避免密钥管理接口本身成为攻击入口。

Secret 禁止出现在 URL、请求体、响应体、应用日志、错误日志或前端代码中。

---

## 5. 公共响应格式

### 5.1 成功

```json
{
  "ok": true,
  "requestId": "req_01J5X9R0V2B2A6D7F8G9H0JKM1",
  "serverTime": "2026-08-19T07:03:00.123Z",
  "data": {}
}
```

### 5.2 失败

```json
{
  "ok": false,
  "requestId": "req_01J5X9R0V2B2A6D7F8G9H0JKM1",
  "serverTime": "2026-08-19T07:03:00.123Z",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "packetCount 必须介于 2 到 1000",
    "retryable": false,
    "details": {}
  }
}
```

`requestId` 由红包调度服务器生成，用于双方排查问题。错误信息不得包含密钥、完整堆栈、数据库结构或手机端敏感信息。

---

## 6. 接口一：鉴权与密钥联调

### `POST /api/v1/system/ping`

用于部署检查和新密钥切换前验证，不触发任何红包业务。

请求：

```json
{
  "echo": "rotation-test-20260819"
}
```

响应：

```json
{
  "ok": true,
  "requestId": "req_01J5X9R0V2B2A6D7F8G9H0JKM1",
  "serverTime": "2026-08-19T07:03:00.123Z",
  "data": {
    "echo": "rotation-test-20260819",
    "service": "tng-packet-scheduler",
    "apiVersion": "v1"
  }
}
```

---

## 7. 接口二：创建红包

### `POST /api/v1/packets/create`

该接口只负责**接受并持久化创建任务**，不得等待手机端完成全部 UI 操作后才返回。手机建包属于异步任务。

### 7.1 请求

```json
{
  "packetId": "pkt_8f3c2a4d7e914df6b8a0c1e2f3456789",
  "totalAmountCents": 10120,
  "packetCount": 124
}
```

字段：

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `packetId` | string | 是 | 游戏后端生成，必须符合 `^pkt_[a-f0-9]{32}$` |
| `totalAmountCents` | integer | 是 | 红包总额，必须 **大于 RM 1.00**，即最小 `101` |
| `packetCount` | integer | 是 | 红包个数，范围 `2–1000` |

额外校验：

```text
totalAmountCents >= packetCount
```

原因是每个红包至少需要 `RM 0.01`。例如 `101` 分不能创建 `200` 个红包。

调度服务可以根据 TNG 账号余额、单笔限额、月限额或风险策略设置更严格的上限，但必须返回明确错误码，不能静默修改金额或个数。

### 7.2 首次接受响应

HTTP `202 Accepted`：

```json
{
  "ok": true,
  "requestId": "req_01J5X9R0V2B2A6D7F8G9H0JKM1",
  "serverTime": "2026-08-19T07:03:00.123Z",
  "data": {
    "packetId": "pkt_8f3c2a4d7e914df6b8a0c1e2f3456789",
    "status": "QUEUED",
    "duplicate": false,
    "acceptedAt": "2026-08-19T07:03:00.100Z",
    "pollAfterMs": 1500
  }
}
```

### 7.3 幂等行为

`packetId` 是创建接口的幂等键：

- 相同 `packetId` + 相同金额 + 相同个数：不得重复建包，返回原任务，`duplicate: true`；
- 相同 `packetId` + 不同金额或个数：HTTP `409`，返回 `IDEMPOTENCY_CONFLICT`；
- 客户端超时、不确定请求是否成功时：必须使用**同一 packetId、相同参数**重试；
- 调度服务必须先把 `packetId` 唯一记录持久化，再把任务交给手机 worker；
- 即使消息队列重复投递，也最多只能实际创建一个 TNG 红包。

重复请求响应示例：

```json
{
  "ok": true,
  "requestId": "req_01J5X9R0V2B2A6D7F8G9H0JKM2",
  "serverTime": "2026-08-19T07:03:02.123Z",
  "data": {
    "packetId": "pkt_8f3c2a4d7e914df6b8a0c1e2f3456789",
    "status": "CREATING",
    "duplicate": true,
    "acceptedAt": "2026-08-19T07:03:00.100Z",
    "pollAfterMs": 1500
  }
}
```

---

## 8. 接口三：查询红包和领取情况

### `POST /api/v1/packets/query`

根据 `packetId` 返回：

- 建包处理状态；
- TNG 分享链接和 Deep Link；
- 已领取人数与金额汇总；
- 新增领取人的姓名、领取时间和金额。

### 8.1 请求

```json
{
  "packetId": "pkt_8f3c2a4d7e914df6b8a0c1e2f3456789",
  "afterSequence": 0,
  "limit": 200
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `packetId` | string | 是 | 创建红包时传入的红包 ID |
| `afterSequence` | integer | 否 | 只返回序号大于该值的领取记录，默认 `0` |
| `limit` | integer | 否 | 单页记录数，默认 `200`，范围 `1–500` |

首次查询传 `afterSequence: 0`。后续将上次响应的 `nextSequence` 原样传回，即可只取得新增记录。

### 8.2 红包已创建响应

```json
{
  "ok": true,
  "requestId": "req_01J5X9R0V2B2A6D7F8G9H0JKM3",
  "serverTime": "2026-08-19T07:03:08.123Z",
  "data": {
    "packetId": "pkt_8f3c2a4d7e914df6b8a0c1e2f3456789",
    "status": "CLAIMING",
    "totalAmountCents": 10120,
    "packetCount": 124,
    "shareUrl": "https://links.tngdigital.com.my/moneypacket/abc123XYZ",
    "deepLink": "tngdwallet://client/dl/transfer/moneyPacket/claim?p=706e93...&v=2",
    "claimedCount": 2,
    "claimedAmountCents": 190,
    "remainingCount": 122,
    "remainingAmountCents": 9930,
    "claimsFinal": false,
    "claims": [
      {
        "claimId": "clm_01J5X9W6E1Y7M4D3C2B1A0Z9X8",
        "sequence": 1,
        "tngName": "TAN AH KAU",
        "amountCents": 102,
        "claimedAt": "2026-08-19T07:03:05.230Z"
      },
      {
        "claimId": "clm_01J5X9W8M2Y7M4D3C2B1A0Z9X9",
        "sequence": 2,
        "tngName": "SITI BINTI ALI",
        "amountCents": 88,
        "claimedAt": "2026-08-19T07:03:06.015Z"
      }
    ],
    "nextSequence": 2,
    "hasMore": false,
    "acceptedAt": "2026-08-19T07:03:00.100Z",
    "linkReadyAt": "2026-08-19T07:03:04.200Z",
    "updatedAt": "2026-08-19T07:03:06.100Z",
    "completedAt": null,
    "failure": null,
    "pollAfterMs": 3000
  }
}
```

### 8.3 链接未就绪响应

```json
{
  "ok": true,
  "requestId": "req_01J5X9R0V2B2A6D7F8G9H0JKM4",
  "serverTime": "2026-08-19T07:03:02.123Z",
  "data": {
    "packetId": "pkt_8f3c2a4d7e914df6b8a0c1e2f3456789",
    "status": "CREATING",
    "totalAmountCents": 10120,
    "packetCount": 124,
    "shareUrl": null,
    "deepLink": null,
    "claimedCount": 0,
    "claimedAmountCents": 0,
    "remainingCount": 124,
    "remainingAmountCents": 10120,
    "claimsFinal": false,
    "claims": [],
    "nextSequence": 0,
    "hasMore": false,
    "failure": null,
    "pollAfterMs": 1500
  }
}
```

### 8.4 分页规则

- 每条领取记录分配不可变的 `claimId`；
- `sequence` 在同一个红包内从 `1` 开始严格递增；
- 同一领取记录在所有查询中必须保持相同的 `claimId`、`sequence`、姓名、金额和时间；
- 按 `sequence` 升序返回；
- `hasMore: true` 时，客户端应立即以 `nextSequence` 请求下一页；
- `hasMore: false` 时，按 `pollAfterMs` 等待后再查询新增记录；
- 即使不同领取人同名，也必须是两条不同的 `claimId`；
- `tngName` 必须保留 TNG 原始显示内容，不得擅自清洗、改写或脱敏。

调度服务只有在确认领取记录稳定后才可以返回。已返回记录不得静默修改；如确需更正，双方另行使用版本化的“更正事件”协议，v1 不支持直接覆盖。

---

## 9. 红包状态

| 状态 | 说明 | 是否有链接 | 是否继续查询 |
| --- | --- | --- | --- |
| `QUEUED` | 已接受，等待设备或账号 | 否 | 是 |
| `CREATING` | 手机端正在创建红包 | 否 | 是 |
| `READY` | 链接已生成，尚未发现领取 | 是 | 是 |
| `CLAIMING` | 已出现领取记录，红包仍有效 | 是 | 是 |
| `COMPLETED` | 所有红包已领取完毕 | 是 | 否 |
| `EXPIRED` | 红包已结束，存在未领取余额 | 是 | 否 |
| `FAILED` | 创建失败，没有可用红包 | 否 | 否 |
| `CANCELLED` | 任务被人工或风控取消 | 可能 | 否 |

状态只能按生命周期前进，不得从终态回退。

当且仅当 `claimsFinal: true` 时，领取列表才被视为最终结果。`COMPLETED`、`EXPIRED`、`FAILED` 和 `CANCELLED` 必须返回 `claimsFinal: true`。

进入 `READY`、`CLAIMING` 或 `COMPLETED` 时，`shareUrl` 与 `deepLink` 至少存在一个，建议两个都提供：

- `shareUrl`：供 Telegram Mini App / 浏览器打开；
- `deepLink`：直接唤起 TNG App 的兜底方式。

---

## 10. 错误码

| HTTP | code | 含义 | 客户端处理 |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 请求字段不合法 | 修正请求，不重试原参数 |
| 401 | `AUTH_KEY_UNKNOWN` | keyId 不存在 | 检查环境和 keyId |
| 401 | `AUTH_KEY_REVOKED` | 密钥已撤销或过期 | 切换新密钥 |
| 401 | `AUTH_TIMESTAMP_INVALID` | 时间偏差超过 300 秒 | 同步 NTP 后重试 |
| 401 | `AUTH_NONCE_REPLAY` | nonce 已使用 | 使用新 nonce 重新签名 |
| 401 | `AUTH_BODY_HASH_MISMATCH` | 请求体哈希不一致 | 检查原始 JSON 发送方式 |
| 401 | `AUTH_SIGNATURE_INVALID` | HMAC 签名不一致 | 检查签名算法和 Secret |
| 404 | `PACKET_NOT_FOUND` | packetId 不存在 | 不重试 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同 ID 对应不同金额或个数 | 生成新 packetId 或修正程序 |
| 422 | `INVALID_DISTRIBUTION` | 金额与个数组合不可创建 | 修正金额或个数 |
| 422 | `AMOUNT_LIMIT_EXCEEDED` | 超出账号或服务限额 | 运营处理 |
| 429 | `RATE_LIMITED` | 请求频率过高 | 按 `Retry-After` 退避 |
| 503 | `NO_CAPACITY` | 暂无可用设备或发包账号 | 退避后重试创建请求 |
| 503 | `SERVICE_UNAVAILABLE` | 调度器暂时不可用 | 指数退避 |
| 500 | `INTERNAL_ERROR` | 未知服务端错误 | 指数退避并告警 |

异步创建已经被接受后发生的失败，不通过查询接口的 HTTP 错误表示，而是：

```json
{
  "status": "FAILED",
  "claimsFinal": true,
  "failure": {
    "code": "TNG_CREATE_FAILED",
    "message": "TNG 拒绝创建红包",
    "retryable": false
  }
}
```

不得把 TNG PIN、账号完整号码、内部异常堆栈或手机控制细节返回给调用方。

---

## 11. 调用方轮询与重试策略

### 11.1 创建阶段

1. 调用创建接口；
2. HTTP 超时或 5xx：使用同一个 `packetId` 和相同参数重试；
3. 收到 `202` 后按 `pollAfterMs` 查询；
4. 直到状态进入 `READY`、`FAILED` 或 `CANCELLED`；
5. `READY` 后立即把链接发布到游戏房间。

### 11.2 领取阶段

1. 使用 `afterSequence: 0` 首次查询；
2. 保存返回的 `nextSequence`；
3. 之后按 `pollAfterMs` 增量查询；
4. `hasMore: true` 时立即翻页；
5. `claimsFinal: true` 后停止轮询；
6. 每个 `claimId` 在游戏后端也必须唯一去重。

建议节奏：

- 创建中：每 `1–2` 秒查询；
- 抢包中：每 `2–3` 秒查询；
- 游戏倒计时结束但调度器未确认终态：每 `5–10` 秒查询，最多继续两分钟；
- 网络错误：`1s → 2s → 4s → 8s → 16s` 指数退避，并加入随机抖动。

推荐 HTTP 超时：

- `system/ping`：5 秒；
- `packets/create`：10 秒；
- `packets/query`：10 秒。

---

## 12. 红包调度服务器实现要求

推荐内部结构：

```text
API 层
  ├─ HMAC 验签、防重放、限流
  ├─ 创建任务（packetId 唯一）
  └─ 查询任务和领取明细

任务队列
  └─ 按 packetId 加分布式锁/租约，保证一包只派给一台手机

手机 Worker
  ├─ 创建 TNG 红包
  ├─ 回写 shareUrl / deepLink
  └─ 采集领取姓名、金额、时间

数据库
  ├─ packet_jobs
  ├─ packet_claims
  └─ api_keys
```

必须具备以下数据库约束：

```text
packet_jobs.packet_id UNIQUE
packet_claims.claim_id UNIQUE
packet_claims (packet_id, sequence) UNIQUE
```

必须保证：

- 接口接受创建请求前先持久化任务；
- 同一 `packetId` 同时只能有一个 worker 持有创建租约；
- worker 崩溃后租约可安全转移，但不得再次创建已经成功的 TNG 红包；
- 抓取到的领取记录先落库，再对查询接口可见；
- 对外查询只读取已确认数据，不直接依赖手机当前在线；
- 应用重启后任务、链接、领取记录和 sequence 不丢失；
- 姓名等个人数据加密存储，日志中脱敏；
- TNG 链接视为敏感 bearer 数据，不写公开日志。

---

## 13. 限流与可用性建议

建议服务端默认限流：

| 接口 | 每个 keyId 的建议上限 |
| --- | --- |
| `/api/v1/system/ping` | 60 次/分钟 |
| `/api/v1/packets/create` | 120 次/分钟 |
| `/api/v1/packets/query` | 1200 次/分钟 |

调度器 API 应快速返回：

- 创建任务接受响应 P95 小于 1 秒；
- 查询响应 P95 小于 500 毫秒；
- API 不应同步等待云手机完成操作；
- 领取数据从调度器落库到查询可见，目标延迟小于 3 秒。

服务端至少保留红包及领取明细 30 天，以便对账；超过保存期前双方需另行确认归档策略。

---

## 14. 安全要求

生产环境必须做到：

1. HTTPS + 正确证书校验；
2. HMAC-SHA256 请求签名；
3. timestamp + nonce 防重放；
4. keyId 支持双密钥重叠轮换；
5. 游戏后端出口 IP 白名单；
6. Secret 使用 KMS、Secret Manager 或加密配置保存；
7. 日志不得记录 Secret、完整签名、TNG 姓名或完整红包链接；
8. 数据库中的领取姓名必须加密；
9. 创建接口按 `packetId` 幂等；
10. 对创建频率、总额和账号余额设置风控阈值；
11. 测试和生产使用不同域名、数据库、账号与密钥；
12. 管理员修改设备、账号、限额或密钥必须写审计日志。

---

## 15. 联调交付清单

### 15.1 红包调度服务方提供给游戏后端

1. 测试环境 Base URL；
2. 生产环境 Base URL；
3. 测试环境 `keyId + secret`；
4. 生产环境 `keyId + secret`（上线前再提供）；
5. IP 白名单已放行的确认；
6. 单笔金额、单日金额、设备并发等实际限制；
7. 两个真实测试用 TNG 领取账号；
8. 服务告警联系人。

### 15.2 游戏后端提供给红包调度服务方

1. 测试与生产服务器的固定出口 IP；
2. 预计每分钟创建红包数；
3. 预计每个红包最大领取人数；
4. 联调红包的金额和时间窗口；
5. 游戏后端告警联系人。

双方不得通过普通群聊明文发送 Secret，推荐使用一次性加密消息或企业密码管理器。

---

## 16. 验收用例

对接完成必须逐项通过：

1. 固定测试向量的 contentHash 和 signature 完全一致；
2. 正确签名调用 `system/ping` 成功；
3. 错误 Secret、过期 timestamp、重复 nonce 均被拒绝；
4. `100` 分创建请求被拒绝，`101` 分且 2 个可受理；
5. `packetCount=1` 和 `packetCount=1001` 均被拒绝；
6. 金额分数小于红包个数时返回 `INVALID_DISTRIBUTION`；
7. 创建请求超时后用同一 packetId 重试，不会重复创建；
8. 同一 packetId 改金额重试返回 `IDEMPOTENCY_CONFLICT`；
9. 查询能返回 shareUrl 或 deepLink；
10. 同名领取人能以不同 claimId、sequence 正确返回；
11. 1000 条领取记录可以通过分页完整读取且无重复、无缺失；
12. 服务重启后 packetId、链接、领取数据和 sequence 不丢失；
13. 新旧密钥重叠期内都可调用，旧密钥撤销后立即失败；
14. 真实小额红包完成“创建 → 出链 → 领取 → 查询最终明细”全流程。

---

## 17. 与至尊牛牛系统的字段映射

| 调度器字段 | 至尊牛牛系统用途 |
| --- | --- |
| `packetId` | 关联本系统 `Packet` 与外部红包任务 |
| `totalAmountCents` | 校验本局红包总额 |
| `packetCount` | 校验本局参与人数/红包份数 |
| `shareUrl` | 保存为 `Packet.claimUrl` 并发布至游戏房间 |
| `deepLink` | 保存为 `Packet.deepLink`，作为 TNG App 唤起兜底 |
| `claimId` | 外部领取记录幂等键 |
| `tngName` | 与本局玩家 KYC 实名匹配 |
| `amountCents` | 生成牌型、积分和结算数据 |
| `claimedAt` | 领取审计时间 |
| `claimsFinal` | 决定是否停止领取明细轮询 |

调度器按本协议实现并提供测试 Base URL、`keyId` 和 `secret` 后，至尊牛牛后端即可开发对应客户端并接入现有 `publishPacket`、`recordClaim(source=PROVIDER)` 流程。

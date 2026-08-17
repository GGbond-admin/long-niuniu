# TNG 手机端回调接口文档

> 面向对象：手机端采集程序开发者
> 版本：v1（2026-08-17）

手机端负责在 TNG App 内**创建红包**并**采集领取明细**，通过下面三个接口与游戏后端交互。

- 后端不会主动连接手机端，全部由手机端发起请求。
- 建包与领取明细是两个独立接口，可以分别独立重试。

---

## 1. 基础约定

| 项 | 值 |
| --- | --- |
| Base URL | `https://<后端域名>` |
| 编码 | 请求与响应均为 `application/json; charset=utf-8` |
| 金额单位 | **分（整数）**，例如 `RM 101.20` → `10120` |
| 时间格式 | ISO 8601 带时区，例如 `2026-08-17T19:20:31+08:00` |
| 时区 | 业务以马来西亚时间（UTC+8）为准 |

金额一律用整数分，禁止使用浮点小数，避免精度误差导致对不上账。

---

## 2. 鉴权

每个请求都必须带以下三个请求头：

| 请求头 | 说明 |
| --- | --- |
| `Authorization` | `Bearer <TNG_INGEST_TOKEN>`，由后端分配 |
| `X-Timestamp` | 请求时的 Unix 毫秒时间戳，例如 `1786000831000` |
| `X-Signature` | HMAC-SHA256 签名，见下方算法 |

### 签名算法

拼接待签名字符串（`\n` 为换行符）：

```
signBase = <X-Timestamp> + "\n" + <HTTP方法大写> + "\n" + <路径含查询串> + "\n" + <请求体原文>
```

- `<HTTP方法大写>`：`GET` 或 `POST`
- `<路径含查询串>`：例如 `/api/internal/tng/jobs/pending?deviceId=phone-01`
- `<请求体原文>`：POST 时为实际发送的 JSON 字符串（**必须与发送内容逐字节一致**）；GET 时为空字符串

再取 HMAC：

```
X-Signature = hex( HMAC_SHA256( TNG_INGEST_SECRET, signBase ) )
```

Node.js 示例：

```js
import crypto from 'node:crypto';

function signedHeaders(method, pathWithQuery, bodyString = '') {
  const timestamp = Date.now().toString();
  const signBase = `${timestamp}\n${method.toUpperCase()}\n${pathWithQuery}\n${bodyString}`;
  const signature = crypto
    .createHmac('sha256', process.env.TNG_INGEST_SECRET)
    .update(signBase)
    .digest('hex');
  return {
    Authorization: `Bearer ${process.env.TNG_INGEST_TOKEN}`,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json',
  };
}
```

Python 示例：

```python
import hmac, hashlib, time

def signed_headers(method: str, path_with_query: str, body: str = "") -> dict:
    ts = str(int(time.time() * 1000))
    sign_base = f"{ts}\n{method.upper()}\n{path_with_query}\n{body}"
    sig = hmac.new(SECRET.encode(), sign_base.encode(), hashlib.sha256).hexdigest()
    return {
        "Authorization": f"Bearer {TOKEN}",
        "X-Timestamp": ts,
        "X-Signature": sig,
        "Content-Type": "application/json",
    }
```

### 时间戳窗口

`X-Timestamp` 与服务器时间相差超过 **5 分钟**会被拒绝（`TIMESTAMP_OUT_OF_RANGE`）。请确保手机端/服务器时间已同步 NTP。

---

## 3. 接口一：拉取待建包任务

```
GET /api/internal/tng/jobs/pending?deviceId=phone-01
```

建包**之前**调用，拿到本次要建的金额、份数和关联短码。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deviceId` | string | 是 | 手机端设备标识，固定不变，例如 `phone-01` |
| `limit` | number | 否 | 最多返回几条，默认 `1`，最大 `5` |

### 响应

```json
{
  "ok": true,
  "jobs": [
    {
      "packetId": "clz8k2h9x0001",
      "correlation": "R7C2K9",
      "totalCents": 10120,
      "packetCount": 124,
      "accountLabel": "packerA",
      "accountName": "TAN AH KAU",
      "leaseExpiresAt": "2026-08-17T19:22:00+08:00"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `packetId` | 红包主键，回传时可用（也可只用 `correlation`） |
| `correlation` | **关联短码，必须写进红包祝福语**，并在建包回调时原样带回 |
| `totalCents` | 红包总额（分），必须严格按此金额建包 |
| `packetCount` | 红包个数，必须严格一致 |
| `accountLabel` | 应使用哪个 TNG 发包账号 |
| `leaseExpiresAt` | 任务租约到期时间，到期后会重新派给其它设备 |

### 租约机制

同一个任务在 `leaseExpiresAt` 之前不会派发给其它设备，避免两台手机对同一局重复建包。

- 建议轮询间隔 **2–3 秒**
- 如果本次建包失败，**不要**继续占用，等租约自然过期即可
- `jobs` 为空数组是正常状态，表示当前没有待建包任务

---

## 4. 接口二：回传建包链接

```
POST /api/internal/tng/packet-link
```

在 TNG 里建包成功后立即调用。**这是最关键的一个接口，越快越好**，玩家正在房间里等待开抢。

### 请求体

```json
{
  "deviceId": "phone-01",
  "correlation": "R7C2K9",
  "shareUrl": "https://links.tngdigital.com.my/moneypacket/abc123XYZ",
  "deepLink": "tngdwallet://client/dl/transfer/moneyPacket/claim?p=706e93...&v=2",
  "totalCents": 10120,
  "packetCount": 124,
  "createdAt": "2026-08-17T19:20:31+08:00"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deviceId` | string | 是 | 设备标识 |
| `correlation` | string | 是 | 派单时下发的短码 |
| `shareUrl` | string | 二者至少一个 | TNG 官方 https 分享链 |
| `deepLink` | string | 二者至少一个 | `tngdwallet://` 深链 |
| `totalCents` | number | 是 | 实际建包总额（分），须与派单一致 |
| `packetCount` | number | 是 | 实际红包个数，须与派单一致 |
| `createdAt` | string | 是 | TNG 中建包完成时间 |

**两个链接请尽量都传。** `shareUrl` 用于在 Telegram 内置浏览器打开（兼容性最好），`deepLink` 用于直接唤起 App。只传一个也能工作，但体验会下降。

### 响应

```json
{
  "ok": true,
  "packetId": "clz8k2h9x0001",
  "roundId": "clz8k1abc0001",
  "phase": "CLAIMING",
  "duplicate": false
}
```

`duplicate: true` 表示这条链接此前已登记过，本次为重复提交，已被安全忽略。

### 幂等规则

同一个 `correlation` 重复提交**相同**链接会返回 `ok: true` + `duplicate: true`，不会报错、不会重复扣款。因此网络超时后可以放心重试。

提交**不同**链接会返回 `PACKET_ALREADY_PUBLISHED`。

---

## 5. 接口三：回传领取明细

```
POST /api/internal/tng/claims
```

抢包期间轮询 TNG 的红包领取记录（History / Leaderboard），抓到新的领取就推送过来。

### 请求体

```json
{
  "deviceId": "phone-01",
  "correlation": "R7C2K9",
  "claims": [
    {
      "tngName": "TAN AH KAU",
      "amountCents": 102,
      "claimedAt": "2026-08-17T19:20:44+08:00"
    },
    {
      "tngName": "SITI BINTI ALI",
      "amountCents": 88,
      "claimedAt": "2026-08-17T19:20:46+08:00"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `correlation` | string | 二者至少一个 | 派单短码 |
| `packetId` | string | 二者至少一个 | 红包主键 |
| `claims[].tngName` | string | 是 | TNG 中显示的领取人姓名，**原样上报** |
| `claims[].amountCents` | number | 是 | 领取金额（分） |
| `claims[].claimedAt` | string | 是 | 领取时间 |

`claims` 单次最多 **100 条**。

**姓名必须原样上报**：不要自行改大小写、不要合并空格、不要做任何清洗，归一化与匹配由后端处理。

### 响应

逐条返回处理结果，顺序与请求一致：

```json
{
  "ok": true,
  "results": [
    { "tngName": "TAN AH KAU", "status": "recorded", "userId": "clz8u1234" },
    { "tngName": "SITI BINTI ALI", "status": "pending_review", "reason": "NAME_NOT_MATCHED" }
  ],
  "recorded": 1,
  "pending": 1,
  "duplicate": 0
}
```

| `status` | 含义 | 手机端处理 |
| --- | --- | --- |
| `recorded` | 已匹配到玩家并入账 | 标记已完成，不再重推 |
| `duplicate` | 此前已入账，重复提交 | 标记已完成，不再重推 |
| `pending_review` | 未能自动匹配，已转人工指认 | 标记已完成，**不需要**重推 |

`pending_review` 的常见 `reason`：

| reason | 说明 |
| --- | --- |
| `NAME_NOT_MATCHED` | 本局参与者中没有该实名姓名 |
| `NAME_AMBIGUOUS` | 本局有多个同名玩家，需人工指认 |
| `KYC_NOT_APPROVED` | 匹配到的玩家未完成实名认证 |
| `AMOUNT_EXCEEDS_TOTAL` | 累计金额超过红包总额，疑似数据异常 |

三种 `status` 都属于**已受理**，手机端不需要重推。只有 HTTP 请求本身失败（网络错误 / 5xx）才需要重试。

### 幂等规则

同一条领取（同红包 + 同姓名 + 同金额）重复推送是安全的，后端会去重并返回 `duplicate`。

### 推送节奏建议

- 抢包期间每 **3–5 秒**轮询一次 History
- 只推送本地未确认成功的新增记录
- 抢包结束后**继续同步 1–2 分钟**，覆盖延迟到账的领取记录
- 本地维护「已成功上报」集合，避免重复推送浪费带宽

---

## 6. 错误响应

所有错误返回统一结构：

```json
{
  "error": "CORRELATION_NOT_FOUND",
  "message": "关联短码不存在或已失效"
}
```

### 鉴权与协议类

| HTTP | error | 说明 | 是否重试 |
| --- | --- | --- | --- |
| 401 | `UNAUTHORIZED` | Token 无效 | 否，检查配置 |
| 401 | `INVALID_SIGNATURE` | 签名不匹配 | 否，检查签名算法与请求体原文是否一致 |
| 401 | `TIMESTAMP_OUT_OF_RANGE` | 时间戳超出 5 分钟窗口 | 否，先同步时间 |
| 400 | `VALIDATION` | 字段格式错误，`issues` 内有明细 | 否 |
| 429 | `RATE_LIMITED` | 请求过于频繁 | 是，退避后重试 |
| 500 | `INTERNAL` | 服务端异常 | 是，退避后重试 |

### 业务类

| HTTP | error | 说明 | 是否重试 |
| --- | --- | --- | --- |
| 404 | `CORRELATION_NOT_FOUND` | 短码不存在 / 已失效 | 否 |
| 409 | `INVALID_PHASE` | 该局已不在等待发包阶段（超时被取消） | 否，放弃本次 |
| 409 | `PACKET_ALREADY_PUBLISHED` | 该局已登记过不同的链接 | 否 |
| 400 | `PACKET_AMOUNT_MISMATCH` | 金额或份数与派单不符 | 否，检查建包参数 |
| 400 | `INVALID_PACKET_URL` | 链接格式不合法 | 否 |
| 400 | `INVALID_PACKET_HOST` | 链接域名不在白名单 | 否 |

### 重试策略

对「是否重试 = 是」的错误，采用指数退避：`1s → 2s → 4s → 8s`，最多 5 次。

建包链接（接口二）如果反复失败，说明这一局无法自动开抢，会由运营在后台人工发包，手机端放弃即可。

---

## 7. 完整流程示例

```
每 2-3 秒
  ├─ GET  /api/internal/tng/jobs/pending?deviceId=phone-01
  │     └─ 无任务 → 继续等待
  │
  └─ 有任务（correlation=R7C2K9, 10120分, 124个）
        ├─ 在 TNG 建包，祝福语写入 "R7C2K9"
        ├─ 抓 shareUrl + deepLink
        ├─ POST /api/internal/tng/packet-link
        │     └─ ok → 玩家已可开抢
        │
        └─ 抢包期间每 3-5 秒
              ├─ 读 TNG History
              └─ POST /api/internal/tng/claims（仅推新增）
                    └─ 抢包结束后再续推 1-2 分钟
```

---

## 8. 联调所需信息

后端需要向手机端提供：

1. `Base URL`
2. `TNG_INGEST_TOKEN`
3. `TNG_INGEST_SECRET`（签名密钥，与 Token 不同）
4. 手机端出口 IP（用于后端加白名单）

手机端需要提供给后端：

1. 每台设备的 `deviceId`
2. 每台设备对应的 TNG 发包账号（与后台 `accountLabel` 对齐）

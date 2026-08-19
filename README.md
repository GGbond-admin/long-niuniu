# 至尊牛牛 — Telegram 游戏厅

基于 Telegram 的娱乐平台：Bot（入口/通知）+ Mini App 网页实时游戏房 + 运营管理后台。
需求文档见 [`docs/`](./docs/00-文档目录.md)，全部游戏公式见 [`docs/06-公式与数值配置总表.md`](./docs/06-公式与数值配置总表.md)。

## 项目结构

```
├── docs/            # 需求文档（PRD / 规则 / 后台 / 账务 / 架构 / 公式）
├── apps/
│   ├── backend/     # API + Bot + 游戏引擎（Fastify + Prisma + grammY）
│   ├── miniapp/     # 玩家 Mini App（React + Vite，四 Tab + 准入流程）
│   └── admin/       # 运营管理后台（React + Vite）
└── docker-compose.yml  # PostgreSQL + Redis
```

## 快速开始

```bash
# 1. 依赖
pnpm install

# 2. 数据库
docker compose up -d
cd apps/backend
cp .env.example .env          # 至少填写 SEED_ADMIN_PASSWORD，并配置 Bot / Mini App
pnpm prisma:push              # 建表
pnpm prisma:generate

# 3. 启动（三个终端）
pnpm --filter backend dev     # API :8080（空库按 .env 的初始管理员密码创建账号）
pnpm --filter miniapp dev     # Mini App :5173（/api 代理到 8080）
pnpm --filter admin dev       # 后台 :5174（/api 代理到 8080）

# 4. 测试
pnpm test                     # 游戏公式引擎 42 个用例
```

## 已实现（M1 准入 + M2 钱包基础 + 引擎核心）

### 游戏引擎（`apps/backend/src/engine/`，全部通过单元测试）

- 点数：全数字求和取个位，个位 0 → 10 点（最大点数）
- 牌型：豹子 17x / 满牛 15x / 反顺 14x / 顺子 13x / 对子 12x / 金牛 11x / 牛牛 10x / 普通（点位倍数可配）
- 比牌：等级 → 同级比金额 → 相同平局
- 自爆：普通牌型 ≤3 点判输；双自爆庄赢；特殊牌型豁免（可配）
- 动态范围：普通下注上限=庄钱×0.5%、人数系数分档；梭哈最低 RM20，上限为各自余额
- 玩家上限：普通下注=⌊余额÷最高牌型倍数⌋（完整 RM）；梭哈固定 1:1，可精确到分押上全部余额
- 指令解析：数字下注 / `sh金额` 梭哈 / `0` 撤回
- 结算：闲赢庄池上限赔付+免赔、梭哈固定 1:1、抽水只抽赢方 5%、庄家三费（上庄费 1% / 服务费 38 / 代包费=人数×1.04）
- 返水：自身 0.7% + 直属 0.5% + 二级 0.3%（有效下注口径含庄家特殊规则）

### 后端 API

- Telegram initData 验签登录（多 Bot token 路由）
- 注册准入：邀请人绑定（深链/UID 预览确认）→ 单设备绑定 → 直接进入主页；首次点击钱包才触发实名（姓名+DuitNow+银行户口）
- 钱包：科目化余额（可用/冻结庄池/冻结下注）+ 幂等流水 + 充提工单（人工确认）
- 推广：我的推广数据 + 专属邀请深链
- 后台：登录（JWT）、实名审核（通过自动推 Bot 私聊）、充提审核、游戏配置热更新、Bot 管理、设备解绑、审计日志
- Bot：/start 深链欢迎 + 「进入游戏厅」菜单按钮（**不再**解析群指令/禁言）
- 网页游戏房 API：进房/离房/状态/竞标/下注/撤回/续庄 + WebSocket（阶段推送与房内聊天）

### 前端

- Mini App：准入 → 四 Tab；大厅/消息进入 **网页游戏房**（竞庄/下注/聊天/抢包/成绩单）；钱包按实名门禁
- Admin：实名/充提/网页房管理/对局控制台/游戏配置/Bot 管理

## 下一步（按 PRD 里程碑）

- **M3 打磨**：网页房 UI 体验、系统播报文案、成绩单排版、多实例 Redis Pub/Sub
- **M4 TNG**：红包登记 + 认额录入（姓名匹配）+ 备付台账
- **M5 运营**：推送中心、每日奖励、排行榜、返水日结任务
- **M6 多 Bot**：webhook 模式、推送路由完善

## 默认账号

- 管理后台：`admin / admin123`（首次启动自动创建，请立即修改）

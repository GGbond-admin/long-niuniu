# 榜单与每日奖励视觉升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用生成式图片替换牌桌中的“榜/奖”文字入口，将两个入口放在聊天区右上侧悬浮，并升级排行榜与每日奖励页面的视觉层级。

**Architecture:** 两张生成的透明 PNG 作为统一视觉资产，由牌桌快捷入口、排行榜头图和奖励头图复用；保留现有 API、路由和业务状态，仅调整 React 展示结构与 CSS。所有入口继续使用原有 `/leaderboards` 与 `/rewards` 路由。

**Tech Stack:** React 18、TypeScript、Vite、CSS、PNG 静态资产

---

### Task 1: 生成并接入视觉资产

**Files:**
- Create: `apps/miniapp/public/game-ui/leaderboard-emblem.png`
- Create: `apps/miniapp/public/game-ui/leaderboard-emblem-128.png`
- Create: `apps/miniapp/public/game-ui/rewards-emblem.png`
- Create: `apps/miniapp/public/game-ui/rewards-emblem-128.png`

- [x] **Step 1: 生成两张无文字的金红色游戏徽章**

排行榜使用金色奖杯与月桂，奖励使用红金宝箱；图形在 48px 下仍可辨识。

- [x] **Step 2: 缩放为 512×512 PNG 并放入公开资源目录**

页面通过 `/game-ui/leaderboard-emblem.png` 和 `/game-ui/rewards-emblem.png` 加载。

### Task 2: 将牌桌入口移动到聊天区右侧

**Files:**
- Modify: `apps/miniapp/src/pages/GameRoom.tsx`
- Modify: `apps/miniapp/src/styles.css`

- [x] **Step 1: 将排行榜、奖励入口移入聊天区右侧悬浮层**

两个按钮使用图片、可见文字标签与独立 `aria-label`，点击逻辑继续导航至原路由；金色光环缓慢旋转，图标轻微浮动。

- [x] **Step 2: 删除页面中部的旧文字浮动按钮**

避免新旧入口重复，顶栏仅保留刷新功能并改为紧凑的 SVG 图标按钮。

- [x] **Step 3: 完成 320px–480px 的响应式布局**

按钮触控区域不小于 44px，悬浮层不遮挡聊天气泡，图片不造成布局跳动，并支持减少动态效果偏好。

### Task 3: 美化排行榜页面

**Files:**
- Modify: `apps/miniapp/src/pages/Leaderboards.tsx`
- Modify: `apps/miniapp/src/styles.css`

- [x] **Step 1: 增加带奖杯图片的荣誉头图**

头图展示当前周期、榜单类型、更新时间与榜单人数，图片仅作为视觉内容且包含替代文字。

- [x] **Step 2: 强化前三名领奖台与排名明细**

使用更清晰的金银铜层级、名次标识、当前筛选信息和加载/空状态。

### Task 4: 美化每日奖励页面

**Files:**
- Modify: `apps/miniapp/src/pages/Rewards.tsx`
- Modify: `apps/miniapp/src/styles.css`

- [x] **Step 1: 将宝箱图片融入今日进度头图**

保持完成率、已领、可冲、今日入账等真实数据，并让图片与数据区域在小屏自适应。

- [x] **Step 2: 强化任务卡、状态和得奖名单**

任务进度、奖励金额、库存和状态需要保持一眼可读，已完成与待发放状态不能只依赖颜色。

### Task 5: 验证

**Files:**
- Test: `apps/miniapp/src/pages/GameRoom.tsx`
- Test: `apps/miniapp/src/pages/Leaderboards.tsx`
- Test: `apps/miniapp/src/pages/Rewards.tsx`
- Test: `apps/miniapp/src/styles.css`

- [x] **Step 1: 检查编辑文件诊断**

使用 IDE 诊断确认没有新增 TypeScript 或 CSS 错误。

- [x] **Step 2: 构建小程序**

Run: `pnpm --filter miniapp build`

Expected: TypeScript 编译与 Vite 构建成功。

- [x] **Step 3: 检查移动端视觉**

在 375px 宽度确认右上角按钮、头图、榜单和奖励任务没有横向溢出，并检查减少动态效果偏好。

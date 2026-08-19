# Banker-Scoped Trend in Scoreboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the standalone banker trend into the bottom of each scoreboard and make every room/banker pair keep an independent trend across non-consecutive banker rounds.

**Architecture:** Rebuild the previous trend from finished rounds filtered by `roomId + bankerId`, deriving one label from each immutable scoreboard snapshot. Append the current banker result, store the rebuilt trend in both `RoundScoreboard.bankerSummary` and `BankerStat.trendRecent`, and render that snapshot as the final scoreboard section. Remove the separate Miniapp trend strip.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Vitest, React, CSS.

---

### Task 1: Make trend helpers banker-scoped

**Files:**
- Modify: `apps/backend/src/engine/settlement.ts`
- Test: `apps/backend/src/engine/settlement.test.ts`

- [x] Replace the room-scoped helper name/comment with `continueBankerTrend`.
- [x] Add `bankerTrendLabelFromSummary(summary)` to derive `9点`, `豹子`, `对子`, etc. from one historical `bankerSummary`.
- [x] Update tests to cover normal points, special hands, invalid snapshots, truncation, and independent A/B history inputs.
- [x] Run `pnpm --filter backend exec vitest run src/engine/settlement.test.ts`.

### Task 2: Rebuild history by banker identity during settlement

**Files:**
- Modify: `apps/backend/src/services/game.ts`
- Modify: `apps/backend/prisma/schema.prisma`
- Create: `apps/backend/prisma/migrations/20260819195000_banker_trend_identity/migration.sql`

- [x] Query previous `FINISHED` rounds using the current `roomId` and `bankerId`, ordered by `seqNo desc`, limited by `trendLength`.
- [x] Reverse the snapshots, derive one label per round, then append the current result with `continueBankerTrend`.
- [x] Stop sourcing history from the room’s latest unrelated banker and overwrite the current banker’s `trendRecent` with the repaired sequence.
- [x] Add the index `@@index([roomId, bankerId, phase, seqNo])` and matching SQL index for efficient returning-banker lookups.

### Task 3: Put trend at the scoreboard bottom

**Files:**
- Modify: `apps/backend/src/bot/messages.ts`
- Test: `apps/backend/src/bot/messages.test.ts`

- [x] Read and sanitize `bankerSummary.trend`.
- [x] Append a final section after banker notes and any presentation footer:

```text
━━━━━━━━━━━━━━━━━━
庄家走势
5点 → 7点 → 9点 → 豹子
```

- [x] Verify empty/malformed trends do not create a blank section and chunk size remains at most 3900 bytes.
- [x] Run `pnpm --filter backend exec vitest run src/bot/messages.test.ts`.

### Task 4: Remove the standalone Miniapp trend strip

**Files:**
- Modify: `apps/miniapp/src/pages/GameRoom.tsx`
- Modify: `apps/miniapp/src/styles.css`

- [x] Remove `scoreTrend`, `BankerTrend`, the `bankerTrend` memo, and the top-level `<BankerTrend />` mount.
- [x] Remove `.banker-trend*` styles and the small-screen overrides.
- [x] Build the Miniapp and verify a scoreboard contains the trend only at its bottom.

### Task 5: Regression verification

**Files:**
- Verify only; do not commit unless explicitly requested.

- [x] Run focused settlement and scoreboard tests.
- [x] Run the complete backend test suite.
- [x] Run backend and Miniapp builds; report unrelated pre-existing failures separately.
- [x] Check IDE diagnostics for all edited files.

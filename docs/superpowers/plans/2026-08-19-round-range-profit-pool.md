# Round-Range Profit Pool and Agent Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace new daily profit-pool settlement with auditable room-and-round-range settlement, immutable agent snapshots, an admin agent-network big screen, and per-agent dashboards.

**Architecture:** Keep `ProfitPoolDaily` and `AgentProfitShare` as read-only legacy history. New settlements use normalized `ProfitPoolBatch`, per-round unique locks, agent/player snapshot rows, and idempotent payout ledger keys. All financial calculations happen server-side; preview is read-only, generation atomically snapshots and locks, and distribution is a separate irreversible action.

**Tech Stack:** PostgreSQL + Prisma 6, Fastify 5, Zod, Vitest, React 18, TypeScript, Vite.

---

### Task 1: Add the round-range accounting schema

**Files:**
- Modify: `apps/backend/prisma/schema.prisma`
- Create: `apps/backend/prisma/migrations/20260819030000_profit_pool_round_batches/migration.sql`

- [ ] Add `ProfitPoolBatch`, `ProfitPoolRoundLock`, `ProfitPoolAgentSnapshot`, `ProfitPoolPlayerSnapshot`, `ProfitPoolCutover`, and `ProfitPoolSequence`.
- [ ] Add unique constraints for `poolCode`, `roundId`, `(roomId, seqNo)`, and `(poolId, sourceAgentId)`.
- [ ] Add `Settlement(roundId)` and batch history indexes.
- [ ] Backfill a conservative per-room cutover through the highest terminal round only when legacy distributed/no-distribution daily pools exist.
- [ ] Run `pnpm --filter backend prisma:generate` and validate the schema.

### Task 2: Implement pure range calculations and snapshot aggregation

**Files:**
- Create: `apps/backend/src/services/profitPoolRange.ts`
- Create: `apps/backend/src/services/profitPoolRange.test.ts`
- Modify: `apps/backend/src/services/profitPool.ts`

- [ ] Add exact basis-point expense calculation: `expense = round(turnover × expenseBps ÷ 10000)`.
- [ ] Load every round in the inclusive range; reject missing or non-terminal rounds, include cancelled rounds as zero-value locked rounds.
- [ ] Rebuild player and banker effective turnover from settlement rows using each round's rebate configuration, excluding virtual users.
- [ ] Split rake into player-win and banker-win amounts and preserve the current double-sided effective-turnover convention.
- [ ] Aggregate live agent/player ownership only for preview, compute differential shares with the existing `computeAgentShares`, and derive team counts.
- [ ] Produce a deterministic calculation fingerprint for stale-preview detection.
- [ ] Cover range boundaries, ties, virtual users, cancelled rounds, missing/non-terminal rounds, exact expenses, tree aggregation, and conservation in Vitest.

### Task 3: Implement atomic generation and idempotent distribution

**Files:**
- Create: `apps/backend/src/services/profitPoolBatches.ts`
- Create: `apps/backend/src/services/profitPoolBatches.test.ts`
- Modify: `apps/backend/src/services/backgroundJobs.ts`

- [ ] Validate cutover and absence of legacy pending reports.
- [ ] Generate `TBYYYYMMDD####` from a transactional daily sequence.
- [ ] In one serializable transaction, recompute, verify the preview fingerprint, create the batch, insert every round lock, and persist immutable agent/player snapshots.
- [ ] Translate unique-lock conflicts into `RANGE_OVERLAP`.
- [ ] Distribute only a `PENDING` batch, using compare-and-set status and `profit-share:{poolCode}:{sourceAgentId}` ledger idempotency keys.
- [ ] Never release locks after formal generation; generated history remains auditable.
- [ ] Remove the daily profit-pool background generation call while retaining legacy records.
- [ ] Test concurrent overlap, stale previews, snapshot immutability, no-distribution batches, and repeat distribution.

### Task 4: Replace the admin API with batch contracts

**Files:**
- Modify: `apps/backend/src/routes/profitPool.ts`
- Modify: `apps/backend/src/server.ts`

- [ ] Add room/range metadata, range validation, preview, generate, batch detail, batch history, distribute, export, network, and agent-dashboard endpoints.
- [ ] Keep agent CRUD and binding endpoints.
- [ ] Require `SUPER` or `FINANCE` for all company financial/network endpoints.
- [ ] Add stable Chinese errors for invalid range, overlap, non-terminal rounds, cutover, stale preview, and legacy pending reports.
- [ ] Audit preview-independent financial mutations with before/after identifiers and IP address.
- [ ] Return all bigint money fields as decimal strings.

### Task 5: Add reliable live/team metrics

**Files:**
- Modify: `apps/backend/src/services/roomHub.ts`
- Create: `apps/backend/src/services/agentDashboard.ts`
- Create: `apps/backend/src/services/agentDashboard.test.ts`

- [ ] Refresh `RoomMember.lastSeenAt` in batches for connected sockets.
- [ ] Define online as an active room membership touched in the last 90 seconds.
- [ ] Aggregate direct/team agent counts, direct/team player counts, online counts, current points, latest-period profit, and lifetime distributed profit in O(agents + bindings).
- [ ] Serve live tree data and immutable historical tree snapshots through the same response shape.
- [ ] Verify arbitrary depth, disabled agents, duplicate room memberships, and historical/live separation.

### Task 6: Build the admin settlement workflow and big screen

**Files:**
- Replace/refactor: `apps/admin/src/ProfitPoolCenter.tsx`
- Create: `apps/admin/src/profit-pool/types.ts`
- Create: `apps/admin/src/profit-pool/SettlementWizard.tsx`
- Create: `apps/admin/src/profit-pool/BatchReport.tsx`
- Create: `apps/admin/src/profit-pool/AgentNetworkScreen.tsx`
- Create: `apps/admin/src/profit-pool/AgentDashboardPanel.tsx`
- Modify: `apps/admin/src/styles.css`

- [ ] Build the DOCX four-step wizard: room/range, required expense percentage, server preview, second confirmation.
- [ ] Disable progression until range and expense validation pass.
- [ ] Show the exact turnover/rake/expense/net formulas and server totals.
- [ ] Build searchable/filterable batch history with pending/distributed/no-distribution states and CSV export.
- [ ] Build a full-screen agent network with search, collapse/drill-down, auto-refresh, online indicators, team counts, points, turnover, and profit.
- [ ] Open a dedicated dashboard for each agent with current and historical metrics.
- [ ] Show actual company residual amount and the equivalent remaining points over the 130-point base.

### Task 7: Upgrade the agent-facing dedicated dashboard

**Files:**
- Modify: `apps/backend/src/routes/agent.ts`
- Modify: `apps/miniapp/src/api.ts`
- Modify: `apps/miniapp/src/pages/AgentReport.tsx`
- Modify: `apps/miniapp/src/ui-v2.css`

- [ ] Replace date navigation with accessible batch selection.
- [ ] Default to the latest batch visible to the authenticated agent.
- [ ] Return only the authenticated agent's subtree and masked player identifiers.
- [ ] Display direct/team agents, direct/team players, current/lifetime profit, online counts, self/override profit, and immutable per-batch details.
- [ ] Keep promotion and direct-subagent point management behavior unchanged.

### Task 8: Document, validate, and review

**Files:**
- Modify: `docs/07-利润池与称桶分配.md`

- [ ] Document round-range accounting, terminal-round handling, permanent locks, basis-point expenses, statuses, snapshots, cutover, and payout idempotency.
- [ ] Run Prisma validation/generation, focused profit-pool tests, all backend tests, and backend/admin/miniapp builds.
- [ ] Run IDE lint diagnostics on every changed source file.
- [ ] Review the complete diff for accidental changes to pre-existing uncommitted work.

# Wallet Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wallet balances and transaction history understandable, complete, refreshable, and safe against duplicate financial submissions.

**Architecture:** Keep `Wallet` as the source of current balances and `LedgerEntry` as the accounting source of truth. Add stable client request IDs to tip, deposit, and withdrawal submission flows; deposit and withdrawal orders persist those IDs, while tips reuse the existing ledger idempotency key. Keep withdrawal amount as the gross debit, but split its completion into net payout and an explicit fee ledger transfer.

**Tech Stack:** React 18, TypeScript, Fastify, Prisma/PostgreSQL, Vitest.

---

### Task 1: Human-readable ledger and correct pagination

**Files:**
- Modify: `apps/miniapp/src/lib/ledger.ts`
- Modify: `apps/miniapp/src/pages/Wallet.tsx`
- Modify: `apps/miniapp/src/pages/FundDetails.tsx`
- Modify: `apps/miniapp/src/api.ts`
- Modify: `apps/backend/src/routes/wallet.ts`
- Test: `apps/backend/src/routes/wallet.pagination.test.ts`

- [x] Add Chinese labels for `tip`, `group_packet_create`, `group_packet_claim`, `group_packet_refund`, `withdraw_fee`, and packet reconciliation types.
- [x] Add a `packet` filter and include `tip`/`withdraw_fee` under fees.
- [x] Make the wallet preview request only `USER_AVAILABLE` entries:

```ts
api.wallet({ scope: 'available', limit: 8 })
```

- [x] Use a stable two-column sort and the last returned row as the continuation cursor:

```ts
orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
const page = entries.slice(0, limit);
const nextCursor = entries.length > limit ? page.at(-1)?.id ?? null : null;
```

- [x] Add a pure pagination regression test proving the first row of page two is not skipped.

### Task 2: Refresh and request-race handling

**Files:**
- Modify: `apps/miniapp/src/pages/Wallet.tsx`
- Modify: `apps/miniapp/src/pages/FundDetails.tsx`

- [x] Show a visible warning when a refresh fails while retaining the last confirmed balance.
- [x] Refresh while the wallet tab is active, and on window focus/visibility changes.
- [x] Guard filtered ledger responses with a monotonically increasing request sequence:

```ts
const requestId = ++requestIdRef.current;
const result = await api.wallet(...);
if (requestId !== requestIdRef.current) return;
```

### Task 3: Persistent request IDs for financial submissions

**Files:**
- Create: `apps/miniapp/src/lib/idempotency.ts`
- Modify: `apps/miniapp/src/api.ts`
- Modify: `apps/miniapp/src/pages/TipSupport.tsx`
- Modify: `apps/miniapp/src/pages/Deposit.tsx`
- Modify: `apps/miniapp/src/pages/Withdraw.tsx`
- Modify: `apps/backend/prisma/schema.prisma`
- Create: `apps/backend/prisma/migrations/20260807190500_wallet_idempotency/migration.sql`
- Modify: `apps/backend/src/routes/wallet.ts`
- Modify: `apps/backend/src/routes/gameRoom.ts`
- Modify: `apps/backend/src/services/groupPacket.ts`
- Test: `apps/backend/src/services/groupPacket.tipIdempotency.test.ts`

- [x] Persist `requestId` on deposit and withdrawal orders with a compound unique key `(userId, requestId)`.
- [x] Generate and retain a request ID in `sessionStorage` until the submission receives a confirmed response.
- [x] Send `requestId` in each tip/deposit/withdraw request body.
- [x] Return the existing result for a repeated request ID with identical parameters; reject reuse with different parameters.
- [x] Use the request ID for tip ledger keys:

```ts
const transferId = `tip:${userId}:${requestId}`;
```

- [x] Suppress duplicate chat announcements for replayed tip requests.

### Task 4: Explicit withdrawal-fee accounting

**Files:**
- Modify: `apps/backend/src/routes/admin.ts`
- Modify: `apps/backend/src/routes/wallet.ts`
- Modify: `apps/miniapp/src/api.ts`
- Modify: `apps/miniapp/src/pages/WalletOrders.tsx`
- Modify: `apps/miniapp/src/lib/ledger.ts`

- [x] On withdrawal completion, move `feeCents` to `PLATFORM_FEES`.
- [x] Move only `amountCents - feeCents` to `ADJUST_CLEARING`.
- [x] Preserve full refund behavior when an order is rejected.
- [x] Return and display gross amount, fee, and estimated net receipt in the user's order list.
- [x] Treat legacy orders without `feeCents` as zero-fee orders.

### Task 5: Verification

**Files:**
- Verify all modified files.

- [x] Run Prisma generation and migration deployment.
- [x] Run focused red/green regression tests.
- [x] Run the complete backend test suite.
- [x] Build backend, Mini App, and Admin.
- [x] Reconcile all wallet fields with each account's latest `balanceAfterCents`.
- [x] Verify all transfer ledger keys have matching `:out` and `:in` entries.

No git commit is included because the user did not request one.

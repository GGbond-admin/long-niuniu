# Bet Liability Reserve Implementation Plan

> **For agentic workers:** Execute the checked steps in order and verify each layer before continuing.

**Goal:** Automatically reduce an oversized bet to the amount the player's balance can fully cover at the round's maximum payout multiplier, reserve that full liability at bet time, and show the accepted amount clearly.

**Architecture:** Compute the maximum payout multiplier from the immutable round settings snapshot (default 17). A pure betting helper combines the requested amount, room range, and whole-RM affordability cap. Persist `Bet.reservedCents`, freeze that amount atomically, consume only the actual loss at settlement, and release the remainder. Return a structured acceptance result through WebSocket and REST so the UI distinguishes requested and accepted amounts.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Fastify/WebSocket, React, Vitest.

---

### Task 1: Pure affordability and multiplier rules

**Files:**
- Modify: `apps/backend/src/engine/hand.ts`
- Modify: `apps/backend/src/engine/betting.ts`
- Modify: `apps/backend/src/engine/hand.test.ts`
- Modify: `apps/backend/src/engine/betting.test.ts`

- [ ] Add `maxPayoutMultiplier(config)` using all payable special and normal multipliers while excluding the fixed “免死” outcome.
- [ ] Add a BigInt-safe acceptance calculator:
  - affordability cap = `floor(balanceCents / multiplier / 100) * 100`
  - room cap = normal or all-in maximum
  - accepted = `min(requested, affordability cap, room cap)`
  - requested below the mode minimum remains invalid
  - an affordability cap below the mode minimum returns a dedicated failure
  - reserve = `accepted * multiplier`
- [ ] Test RM200/RM50 → RM11 accepted and RM187 reserved, RM500/RM100 → RM29/RM493, dynamic room cap, custom multiplier, below-minimum balance, and exact-limit input.

### Task 2: Persist and maintain the liability reserve

**Files:**
- Modify: `apps/backend/prisma/schema.prisma`
- Create: `apps/backend/prisma/migrations/20260815213500_bet_liability_reserve/migration.sql`
- Modify: `apps/backend/src/services/game.ts`
- Create: `apps/backend/src/services/game.betLiability.test.ts`

- [ ] Add `Bet.reservedCents` with a migration that backfills existing bets to `amountCents`, preserving compatibility with already-frozen legacy bets.
- [ ] Make `placeBet` capture the player's wallet, include an existing bet's reserve when editing, calculate acceptance from the round snapshot, freeze the reserve (not merely the stake), persist accepted and reserved values, and write requested/accepted/reserve data to the round event.
- [ ] Return a structured `PlaceBetResult` containing requested amount, accepted amount, available liability balance, affordability cap, room cap, final cap, multiplier, reserve, and adjustment flag.
- [ ] On bet edits, transfer only the reserve difference. On withdrawal, cancellation, and claim forfeiture, release the full stored reserve.
- [ ] Add focused service tests for initial auto-reduction, exact acceptance, edit-up/edit-down reserve differences, and below-minimum rejection.

### Task 3: Settle entirely from the frozen reserve

**Files:**
- Modify: `apps/backend/src/engine/settlement.ts`
- Modify: `apps/backend/src/engine/settlement.test.ts`
- Modify: `apps/backend/src/services/game.ts`

- [ ] Replace settlement-time available-balance capacity with `reservedCents`.
- [ ] Player win or tie: release the full reserve.
- [ ] Banker win: pay banker net and platform rake from the reserve, then release `reserved - paid`; remove settlement-time wallet top-up.
- [ ] Retain defensive shortfall handling only for legacy/corrupt under-reserved bets.
- [ ] Test 17x full loss, lower-multiplier loss with remainder return, player win, tie, and legacy under-reserve behavior.

### Task 4: Propagate and display the actual accepted amount

**Files:**
- Modify: `apps/backend/src/services/chatCommands.ts`
- Modify: `apps/backend/src/services/chatCommands.amountAsChat.test.ts`
- Modify: `apps/backend/src/routes/gameRoom.ts`
- Modify: `apps/backend/src/services/virtualPlayerWorker.ts`
- Modify: `apps/backend/src/services/errorMessages.ts`
- Modify: `apps/miniapp/src/api.ts`
- Modify: `apps/miniapp/src/pages/GameRoom.tsx`
- Modify: `apps/miniapp/src/styles.css`

- [ ] Use the accepted amount as the public chat echo and activity amount; never publish the rejected requested amount as if accepted.
- [ ] Extend private confirmation with requested amount, accepted amount, balance, affordability cap, final cap, multiplier, reserve, and adjustment flag.
- [ ] Add the same optional acceptance block to the REST room-state response.
- [ ] Reorder virtual-player echoing to happen after `placeBet`, using the accepted amount.
- [ ] Show a detailed adjusted confirmation:
  - input amount
  - current liability balance
  - maximum affordable bet and multiplier
  - actual accepted amount
- [ ] Keep the compact existing success toast when no adjustment occurred.

### Task 5: Documentation and verification

**Files:**
- Modify: `apps/admin/src/GameConfigEditor.tsx`
- Modify: `docs/01-产品需求文档-PRD.md`
- Modify: `docs/02-游戏规则说明书.md`
- Modify: `docs/06-公式与数值配置总表.md`

- [ ] Explain that the default maximum multiplier is 17 but risk control uses the highest multiplier in the round snapshot if operators configure a higher value.
- [ ] Replace settlement-time balance top-up language with bet-time full liability reservation and automatic reduction.
- [ ] Generate Prisma Client.
- [ ] Run focused engine/service/chat tests, then the complete backend suite.
- [ ] Run backend, admin, and miniapp typechecks/builds and inspect lints for edited files.

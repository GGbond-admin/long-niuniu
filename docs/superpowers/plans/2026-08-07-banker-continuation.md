# Banker Continuation Implementation Plan

> **For agentic workers:** Execute the checked steps in order and verify each behavior before moving on.

**Goal:** Enforce “highest bid wins; one immediate continuation; then mandatory rebid; the former banker may bid and win again.”

**Architecture:** Keep `Round.isContinued` and `Round.continuationUsed` as the consecutive-run guard. Centralize continuation eligibility in a pure rule helper, apply it again inside the serializable transaction, and let the virtual-player worker invoke the same `continueBanker` service used by real players. Use the finished round’s configuration snapshot for the continuation deadline, fees, next-round timer, and scheduler hold.

**Tech Stack:** TypeScript, Prisma, Vitest, Fastify, Node EventEmitter

---

### Task 1: Centralize and test continuation eligibility

**Files:**
- Create: `apps/backend/src/engine/bankerContinuation.ts`
- Create: `apps/backend/src/engine/bankerContinuation.test.ts`

- [x] Define a pure `continuationError` rule that checks:
  - source round is `FINISHED`;
  - requester is that round’s banker;
  - neither `continuationUsed` nor `isContinued` is set;
  - the deadline has not elapsed;
  - destination is `WAITING`, in the same room, and has exactly `source.seqNo + 1`.
- [x] Add tests for valid first continuation, repeated continuation rejection, stale/non-adjacent round rejection, wrong banker, and expiry.
- [x] Add a scenario test proving an auction-created round can continue once, its continued round must return to auction, and a newly auction-created round resets eligibility for the same banker.

### Task 2: Harden the continuation service and endpoint

**Files:**
- Modify: `apps/backend/src/services/game.ts`
- Modify: `apps/backend/src/routes/gameRoom.ts`

- [x] In `continueBanker`, load the source round’s configuration snapshot and use it for the continuation window, fees, betting duration, and destination snapshot.
- [x] Validate the exact adjacent waiting round within the transaction through `continuationError`; reject stale IDs even if that user was banker in an older finished round.
- [x] Bind the room endpoint to the exact `previousRoundId` advertised to the player, then verify room, phase, and banker before continuing.
- [x] Only expose a continuation action in room state when the currently returned round is the directly adjacent `WAITING` round.

### Task 3: Let eligible virtual bankers continue automatically

**Files:**
- Modify: `apps/backend/src/services/virtualPlayerWorker.ts`

- [x] Handle the `FINISHED` transition.
- [x] If the banker is an enabled virtual player with `canContinue=true`, the assistant is enabled, and the snapshot deadline is open, schedule one delayed call to `continueBanker`.
- [x] Emit `WAITING → BETTING` after success so existing room announcements and virtual betting behavior run.
- [x] Recover eligible finished rounds after process restart so the scheduler does not wait until timeout without giving the virtual banker a chance to continue.

### Task 4: Use one snapshot-aware continuation window everywhere

**Files:**
- Modify: `apps/backend/src/services/roundScheduler.ts`
- Modify: `apps/backend/src/services/gameSettings.ts`

- [x] Make the scheduler’s hold use the previous round’s snapshot rather than current global settings.
- [x] Update the default continuation prompt to state “one continuation per auction win / at most two consecutive rounds / eligible to bid again after mandatory rebid.”

### Task 5: Synchronize product and accounting rules

**Files:**
- Modify: `docs/01-产品需求文档-PRD.md`
- Modify: `docs/02-游戏规则说明书.md`
- Modify: `docs/04-账务与结算说明.md`

- [x] Replace “one continuation per table/player” with the consecutive-run rule.
- [x] Add acceptance wording for mandatory rebid and former-banker re-entry.
- [x] Update accounting test T08 to distinguish a prohibited third consecutive round from a permitted new auction win.

### Task 6: Verify

- [x] Run the focused banker-continuation tests.
- [x] Run the complete backend Vitest suite.
- [x] Run the backend TypeScript build.
- [x] Check diagnostics on all edited TypeScript files and confirm the remaining IDE errors are stale Prisma-client diagnostics; the authoritative TypeScript build passes.

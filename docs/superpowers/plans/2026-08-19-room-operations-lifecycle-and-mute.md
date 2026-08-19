# Room Operations Lifecycle and Global Mute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give operations a clear manual-single-round / automatic-continuous / stopped lifecycle and an independent absolute global-mute switch for the interaction group.

**Architecture:** Persist `RoomStartMode` on the room so every round-start path reads one transactional source of truth. Manual starts explicitly start one round, automatic mode alone permits scheduler/continuation starts, and stopped mode drains the current round without starting another. Persist global mute on the room, broadcast it across WebSocket instances, hide the player composer immediately, and reject all chat/game-input channels server-side.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL, Redis pub/sub, React, Vitest, Playwright.

---

### Task 1: Persist lifecycle and global mute state

**Files:**
- Modify: `apps/backend/prisma/schema.prisma`
- Create: `apps/backend/prisma/migrations/20260819202500_room_operation_lifecycle/migration.sql`

- [ ] Add `RoomStartMode { MANUAL AUTO STOPPED }`.
- [ ] Add `Room.roundStartMode`, `chatMutedAt`, `chatMuteReason`, and `chatMutedByAdminId`.
- [ ] Backfill `AUTO` for rooms whose existing round config has `autoStart=true`; all others remain `MANUAL`.
- [ ] Validate the Prisma schema and regenerate the client.

### Task 2: Enforce the three lifecycle modes

**Files:**
- Modify: `apps/backend/src/services/game.ts`
- Modify: `apps/backend/src/services/roundScheduler.ts`
- Modify: `apps/backend/src/services/bankerContinuationFlow.ts`
- Modify: `apps/backend/src/services/chatCommands.ts`
- Modify: `apps/backend/src/routes/game.ts`
- Modify: `apps/backend/src/routes/admin.ts`
- Modify: `apps/backend/src/services/errorMessages.ts`
- Test: `apps/backend/src/services/roundScheduler.continuation.test.ts`
- Test: `apps/backend/src/services/game.bankerContinuation.test.ts`

- [ ] Extend `startRound` with a source (`MANUAL`, `AUTO`, `REPLACEMENT`) and check `Room.roundStartMode` inside its serializable transaction.
- [ ] Make normal/forced admin start set `MANUAL`, enable the assistant, disable `autoStart`, and start exactly one round.
- [ ] Make automatic start set `AUTO`, enable the assistant, and enable `autoStart`.
- [ ] Make “结束游戏” set `STOPPED` and disable `autoStart` without disabling announcements or cancelling the active round.
- [ ] Allow banker repost replacement in `MANUAL`/`AUTO`, but block it after `STOPPED`.
- [ ] Permit scheduler and banker continuation only in `AUTO`.
- [ ] Keep GameConfigEditor’s legacy `autoStart` setting synchronized with room mode.
- [ ] Add regression tests proving manual mode never opens the following round and stopped mode drains the current round.

### Task 3: Add absolute global mute

**Files:**
- Create: `apps/backend/src/services/roomModeration.ts`
- Modify: `apps/backend/src/services/roomHub.ts`
- Modify: `apps/backend/src/routes/game.ts`
- Modify: `apps/backend/src/routes/gameRoom.ts`
- Modify: `apps/backend/src/services/groupPacket.ts`
- Modify: `apps/backend/src/services/virtualPlayerWorker.ts`
- Test: `apps/backend/src/services/roomHub.clientWindow.test.ts`
- Test: `apps/backend/src/services/groupPacket.sendIdempotency.test.ts`

- [ ] Add idempotent admin mute/unmute service and audit entries.
- [ ] Add `POST /api/admin/rooms/:id/chat-mute` with `{ muted, reason }`.
- [ ] Broadcast `room_moderation` to every player and observer on every backend instance.
- [ ] Include current room mute state in room state and WebSocket session revalidation.
- [ ] Reject chat, emoji, sticker, dice, bidding/betting commands, continuation, user packets, tips, and virtual-player chat while globally muted.

### Task 4: Redesign the operations controls

**Files:**
- Modify: `apps/admin/src/GameOperationsCenter.tsx`
- Modify: `apps/admin/src/styles.css`

- [ ] Replace the ambiguous assistant/start controls with a clear lifecycle block:
  - `正常开局` — one round only.
  - `打开自动开局` — continuous rounds.
  - `结束游戏` — current round finishes; no next round.
- [ ] Keep force start inside advanced settings.
- [ ] Add a separate `全群禁言 / 解除禁言` control with an explicit warning.
- [ ] Display concise current states: entrance, lifecycle mode, group mute, packet channel.

### Task 5: Hide all player input during global mute

**Files:**
- Modify: `apps/miniapp/src/api.ts`
- Modify: `apps/miniapp/src/pages/GameRoom.tsx`
- Modify: `apps/miniapp/src/styles.css`

- [ ] Add `room.chatMute` to `RoomState`.
- [ ] Apply `room_moderation` updates immediately.
- [ ] Give global mute priority over stage/continuation controls, unmount `ChatComposer`, and show only a compact “互动群已禁言” status.
- [ ] Ensure unmute restores controls according to the current game phase.

### Task 6: Documentation and verification

**Files:**
- Modify: `docs/03-管理后台需求.md`
- Modify: `docs/10-游戏管理员与互动群管理.md`
- Modify: `docs/01-产品需求文档-PRD.md`

- [ ] Document the three lifecycle modes and absolute global mute.
- [ ] Run focused lifecycle, moderation, room-hub, and group-packet tests.
- [ ] Run the complete backend suite and backend/admin/Miniapp builds.
- [ ] Validate Prisma, inspect IDE diagnostics, and verify both controls in a browser.
- [ ] Do not commit unless explicitly requested.

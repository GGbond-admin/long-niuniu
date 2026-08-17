# Room Entry Performance and Composer UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make entering an interactive room reliably fast and make the room composer comfortable under weak networks, Telegram fullscreen, and mobile soft keyboards without changing the existing numeric bid/bet commands.

**Architecture:** Shorten the critical path by reusing the authenticated Mini App session, reducing duplicate room-join validation, parallelizing room-state reads, and indexing the state queries that grow with history. Keep WebSocket as the authoritative real-time channel, but add connection watchdog/heartbeat behavior and expose entry/connection states clearly. Keep the current chat-command protocol while holding drafts until the server acknowledges them and making custom tool panels mutually exclusive with the system keyboard.

**Tech Stack:** React 18, TypeScript, Telegram WebApp API, Fastify, WebSocket, Prisma/PostgreSQL, Vitest, Vite.

---

### Task 1: Add database indexes and reduce room-state query latency

**Files:**
- Modify: `apps/backend/prisma/schema.prisma`
- Create: `apps/backend/prisma/migrations/20260817211500_room_entry_performance/migration.sql`
- Modify: `apps/backend/src/routes/gameRoom.ts`
- Modify: `apps/backend/src/services/game.ts`

- [ ] Add `Claim(userId, createdAt)` for the 24-hour participation count and `Round(roomId, phase, seqNo)` for current/finished round lookup.
- [ ] Fetch room and membership concurrently in `buildRoomState`.
- [ ] Run settings, banker, eligibility, claimability, dice-event, pinned-announcement, previous-scoreboard, and 24-hour count queries concurrently after the current round is known.
- [ ] Replace the two-step active-round lookup with one bounded query that preserves the “in-play before waiting” rule.
- [ ] Let the already authenticated/KYC-approved join route skip duplicate user/KYC validation while retaining all checks for virtual-player callers.
- [ ] Skip the membership upsert when the membership is already active.
- [ ] Add structured timing logs for slow joins and slow room-state builds, without logging user secrets.
- [ ] Run focused game service tests and the complete backend test suite.

### Task 2: Remove redundant client bootstrap requests and add bounded networking

**Files:**
- Modify: `apps/miniapp/src/App.tsx`
- Modify: `apps/miniapp/src/api.ts`
- Modify: `apps/miniapp/src/pages/GameDetail.tsx`
- Modify: `apps/miniapp/src/pages/GameRoom.tsx`
- Modify: `apps/miniapp/src/components/SupportInboxToast.tsx`

- [ ] Pass the cached authenticated `Session` into `GameRoom` and remove its redundant `GET /api/me`.
- [ ] Allow the GameDetail entry button to use the route room ID immediately instead of waiting for a repeated lobby response.
- [ ] Add a default fetch timeout and one safe retry for the idempotent room join.
- [ ] Add an 8-second WebSocket connection watchdog, application ping/pong heartbeat, and timer cleanup.
- [ ] Pause the nonessential support-inbox poll while the interactive room route is active.
- [ ] Keep the composer disabled until the room state exists and WebSocket is online.
- [ ] Verify the Mini App production build.

### Task 3: Improve entry and reconnect feedback

**Files:**
- Modify: `apps/miniapp/src/pages/GameRoom.tsx`
- Modify: `apps/miniapp/src/styles.css`

- [ ] Reset entry state on each room/retry attempt.
- [ ] Replace the single loading line with lightweight message skeletons.
- [ ] Show an explicit entry failure state with a “重新进入” action.
- [ ] Show a compact connection bar with “立即重连” when the room state is visible but WebSocket is not online.
- [ ] Give error feedback an alert role and a close control.
- [ ] Keep the existing top status label and exponential reconnect behavior.

### Task 4: Preserve drafts until acknowledgement and fix mobile composer interactions

**Files:**
- Modify: `apps/miniapp/src/components/ChatComposer.tsx`
- Modify: `apps/miniapp/src/pages/GameRoom.tsx`
- Modify: `apps/miniapp/src/styles.css`

- [ ] Make room text submission resolve only after the sender receives its own server echo, a private bet confirmation, or an error/timeout.
- [ ] Keep the input content visible when the server rejects or does not acknowledge the action.
- [ ] Prevent a second submission while acknowledgement is pending.
- [ ] Blur the text input before opening tools/plus and close custom panels when the input regains focus.
- [ ] Add `enterKeyHint="send"` and an always-visible RM mode hint during bid/bet phases.
- [ ] Raise the mobile input text to 16px and make tool tabs/emoji cells comfortably tappable.
- [ ] Keep all existing numeric command semantics and bet-result notices unchanged.

### Task 5: Unify Telegram fullscreen bottom inset and keyboard viewport sizing

**Files:**
- Modify: `apps/miniapp/src/telegram.ts`
- Modify: `apps/miniapp/src/ui-v2.css`
- Modify: `apps/miniapp/src/styles.css`

- [ ] Synchronize `visualViewport.height` to `--app-viewport-height` with a `100vh` fallback.
- [ ] Make Telegram fullscreen initialization idempotent so React StrictMode does not accumulate listeners.
- [ ] Define one `--app-bottom-inset` using browser and Telegram safe-area values.
- [ ] Consume the bottom inset once at the outer room/support footer; remove duplicate drawer padding.
- [ ] Size room and support chat shells from the visible viewport so the soft keyboard cannot cover the composer.
- [ ] Run Mini App lint diagnostics and production build.

### Task 6: Final verification

**Files:**
- Verify all files changed above.

- [ ] Generate Prisma Client.
- [ ] Run focused backend tests for game room behavior.
- [ ] Run the complete backend test suite.
- [ ] Run backend and Mini App production builds.
- [ ] Inspect IDE diagnostics for every edited source file.
- [ ] Review the final diff to ensure existing unrelated working-tree changes were not overwritten.

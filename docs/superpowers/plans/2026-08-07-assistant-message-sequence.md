# Assistant Message Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the verified reference flow so bid countdown precedes the final list and lock, while the real game packet appears before “开始抢包”.

**Architecture:** Keep phase transitions authoritative in the backend, but persist the game packet as a chronological room-chat event before the CLAIMING transition. Render that event in the Mini App feed instead of manufacturing the active packet after all chat messages. Move post-dice assistant copy to the point where all three dice have actually been emitted.

**Tech Stack:** TypeScript, Fastify, Prisma, WebSocket, React, Vitest

---

### Task 1: Correct the auction closing ceremony

**Files:**
- Modify: `apps/backend/src/services/gameSettings.ts`
- Modify: `apps/backend/src/services/bidAuction.ts`
- Modify: `apps/backend/src/services/roomAnnounce.ts`
- Test: `apps/backend/src/services/bidAuction.sequence.test.ts`
- Test: `apps/backend/src/services/roomAnnounce.sequence.test.ts`

- [x] **Step 1: Add templates for countdown start and the post-countdown final list**

Add `bidCountdownStart` and `bidFinalList` to `MessageTemplates`, defaults, and validation:

```ts
bidCountdownStart: '【竞标即将锁定】\n出价时间到，开始 3、2、1 最终确认！',
bidFinalList:
  '【竞标结束 · 最终名单】\n\n本局出价名单：\n{{bidList}}\n\n最高有效出价：{{leader}} · RM {{high}}',
```

- [x] **Step 2: Write a failing auction sequence test**

Use fake timers and mocked Prisma/chat functions. Assert this order:

```ts
[
  'bid-countdown-start',
  '3',
  '2',
  '1',
  'bid-final-list',
  'close-bidding',
]
```

- [x] **Step 3: Implement the persisted closing steps**

Extend the ceremony events with `BID_FINAL_LIST`. Emit countdown-start, then one digit per second, then the final list, wait one more scheduler interval, and call `closeBidding`.

- [x] **Step 4: Put banker lock before the start-betting banner**

Return BETTING announcements in this order:

```ts
[
  text(bankerSelected),
  banner('bet-start'),
  text(betStart),
  countdown('bet', ...),
]
```

- [x] **Step 5: Run focused backend tests**

Run:

```bash
pnpm --filter backend test -- src/services/bidAuction.sequence.test.ts src/services/roomAnnounce.sequence.test.ts
```

Expected: both sequence test files pass.

### Task 2: Anchor the packet and post-dice messages chronologically

**Files:**
- Modify: `apps/backend/src/services/roomHub.ts`
- Modify: `apps/backend/src/routes/game.ts`
- Modify: `apps/backend/src/services/roundScheduler.ts`
- Modify: `apps/backend/src/services/roomAnnounce.ts`
- Modify: `apps/backend/src/services/chatCommands.ts`
- Modify: `apps/backend/src/routes/gameRoom.ts`
- Modify: `apps/backend/src/services/virtualPlayerWorker.ts`
- Modify: `apps/miniapp/src/pages/GameRoom.tsx`

- [x] **Step 1: Add a durable room-feed game-packet message**

Extend `RoomChatMessage.type` with `GAME_PACKET` and add a helper that appends:

```ts
{
  type: 'GAME_PACKET',
  content: JSON.stringify({ id: packetId, roundId, greeting: '恭喜发财，大吉大利' }),
  from: null,
}
```

- [x] **Step 2: Emit the packet before CLAIMING transition copy**

For manual and automatic publication:

```ts
const packet = await publishPacket(...);
appendGamePacketMessage(roomId, { packetId: packet.id, roundId });
gameBus.transition({ from: 'SENDING_PACKET', to: 'CLAIMING', ... });
```

- [x] **Step 3: Move waiting copy until after all dice**

Remove `templates.sealed` from the initial SENDING_PACKET announcement list. Return both `announce` and `waitForPacket` from `throwBankerDice`, then append them after the three individual dice bubbles in real-player and virtual-player paths.

- [x] **Step 4: Render GAME_PACKET in chat order**

Parse the event in `GameRoom.tsx`, render the matching active packet as claimable, render historical packets disabled, and retain the state-derived card only as a fallback when history lacks the event.

- [x] **Step 5: Correct the demo sequence**

Move `demo-packet-live` before `demo-claim-start` so preview mode demonstrates the production order.

### Task 3: Verify the complete change

**Files:**
- Check all files modified above.

- [x] **Step 1: Run backend tests**

```bash
pnpm --filter backend test
```

Expected: all Vitest suites pass.

- [x] **Step 2: Build backend and Mini App**

```bash
pnpm --filter backend build
pnpm --filter miniapp build
```

Expected: both commands exit successfully.

- [x] **Step 3: Check editor diagnostics and inspect the final diff**

Confirm no new TypeScript/linter errors. This workspace is not a Git repository, so no commit step is available.

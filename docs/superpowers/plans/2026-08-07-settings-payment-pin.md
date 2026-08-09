# Settings and Payment PIN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a polished Settings center under “我的”, require a secure six-digit payment PIN after KYC approval, protect withdrawals and player-sent group packets, and expose device and legal-information management.

**Architecture:** Store the payment PIN in a dedicated one-to-one `PaymentPin` table; hash HMAC-peppered PIN material with bcrypt and keep failed-attempt lock state server-side. A KYC-approved user without a PIN is routed to setup after device onboarding; protected financial APIs still enforce the PIN independently of the UI. Device `authVersion` invalidates old JWTs after administrative unbind/reset. Settings pages reuse the Mini App’s refined gold/ivory visual language and existing profile-list patterns.

**Tech Stack:** React 18, React Router, TypeScript, Fastify, Zod, Prisma/PostgreSQL, bcryptjs, Vitest.

---

### Task 1: Payment PIN data model and security service

**Files:**
- Modify: `apps/backend/prisma/schema.prisma`
- Create: `apps/backend/prisma/migrations/20260807195500_payment_pin_settings/migration.sql`
- Create: `apps/backend/src/services/paymentPin.ts`
- Create: `apps/backend/src/services/paymentPin.test.ts`
- Modify: `apps/backend/src/services/user.ts`

- [ ] Add `PaymentPin` with `userId @id`, `hash`, `failedAttempts`, `lockedUntil`, `version`, `setAt`, and `updatedAt`.
- [ ] Add `Device.authVersion`, and `GroupPacket.requestId` with `(senderId, requestId)` uniqueness. Backfill existing packets with their IDs.
- [ ] Reject weak values such as repeated digits and common ascending/descending sequences.
- [ ] Derive bcrypt input with an HMAC keyed by `SENSITIVE_DATA_KEY`:

```ts
const material = createHmac('sha256', env.sensitiveDataKey)
  .update(`payment-pin:v1:${userId}:${pin}`)
  .digest('hex');
const hashValue = await hash(material, 12);
```

- [ ] Lock for 15 minutes after five consecutive failures; return remaining attempts before lock; clear failures after success.
- [ ] Add red/green tests for weak PIN rejection, successful verification, failure counting, lockout, and expired-lock recovery.

### Task 2: Security/settings APIs and device-session invalidation

**Files:**
- Create: `apps/backend/src/routes/settings.ts`
- Modify: `apps/backend/src/routes/auth.ts`
- Modify: `apps/backend/src/routes/onboarding.ts`
- Modify: `apps/backend/src/routes/admin.ts`
- Modify: `apps/backend/src/routes/operations.ts`
- Modify: `apps/backend/src/server.ts`

- [ ] Add authenticated APIs:

```text
GET   /api/settings/security
GET   /api/settings/device
POST  /api/settings/payment-pin
PATCH /api/settings/payment-pin
```

- [ ] Apply KYC and route-specific rate limits to PIN setup/change.
- [ ] Return only `paymentPinSet`, `paymentPinLockedUntil`, and device-safe metadata; never return the hash.
- [ ] Add `deviceVersion` to user JWTs. Permit unbound/new users only on `/api/me` and onboarding endpoints; require active matching devices elsewhere.
- [ ] Increment `authVersion` when an administrator unbinds a device.
- [ ] Add `POST /api/admin/users/:userId/reset-payment-pin` for SUPER/REVIEWER with a required reason; delete the PIN, unbind the device, increment `authVersion`, and write an audit record.
- [ ] Expose payment-PIN status (not hash) in admin user detail.

### Task 3: Protect withdrawals and player group packets

**Files:**
- Modify: `apps/backend/src/routes/wallet.ts`
- Modify: `apps/backend/src/routes/gameRoom.ts`
- Modify: `apps/backend/src/services/groupPacket.ts`
- Create: `apps/backend/src/services/groupPacket.sendIdempotency.test.ts`
- Modify: `apps/miniapp/src/api.ts`

- [ ] Require `paymentPin` in withdrawal and group-packet request schemas.
- [ ] Return existing matching requests before PIN verification so network retries remain idempotent.
- [ ] Verify PIN before any new order/packet or ledger mutation.
- [ ] Persist group-packet `requestId`; suppress duplicate chat bubbles for replayed requests.
- [ ] Reject reuse of a request ID with different amount, count, mode, greeting, account, or sender.
- [ ] Add regression tests proving duplicate packet requests do not transfer twice or broadcast twice.

### Task 4: Payment PIN frontend and mandatory post-KYC setup

**Files:**
- Create: `apps/miniapp/src/components/PaymentPinInput.tsx`
- Create: `apps/miniapp/src/components/PaymentPinSheet.tsx`
- Create: `apps/miniapp/src/pages/PaymentPinSettings.tsx`
- Modify: `apps/miniapp/src/pages/Withdraw.tsx`
- Modify: `apps/miniapp/src/pages/SendRedPacket.tsx`
- Modify: `apps/miniapp/src/App.tsx`
- Modify: `apps/miniapp/src/sessionStore.ts`
- Modify: `apps/miniapp/src/lib/idempotency.ts`

- [ ] Add six-dot numeric PIN inputs with accessible hidden inputs, numeric keyboards, completion states, and no PIN persistence.
- [ ] Open a confirmation sheet before withdrawal or packet submission.
- [ ] Redirect stale/unset states to `/settings/payment-pin` and return to the original operation after setup.
- [ ] Retain one packet `requestId` in session storage until a confirmed response.
- [ ] Refresh `/api/me` on focus/visibility so KYC approval and PIN status update without a full reload.
- [ ] Once invitation and device onboarding are complete, automatically route KYC-approved users without a PIN to setup; keep support/legal pages reachable for recovery.

### Task 5: Settings, device management, and legal center UI

**Files:**
- Create: `apps/miniapp/src/pages/Settings.tsx`
- Create: `apps/miniapp/src/pages/DeviceManagement.tsx`
- Create: `apps/miniapp/src/pages/LegalCenter.tsx`
- Modify: `apps/miniapp/src/pages/Profile.tsx`
- Modify: `apps/miniapp/src/pages/LegalDoc.tsx`
- Modify: `apps/miniapp/src/legal.ts`
- Modify: `apps/miniapp/src/components/Icons.tsx`
- Modify: `apps/miniapp/src/styles.css`

- [ ] Add a visible Settings entry under the “我的” quick-action section.
- [ ] Group settings into “账户安全”, “服务与支持”, and “协议与关于”.
- [ ] Show payment-PIN setup/locked status, current device status/masked identifier/bound time, online support, and app version.
- [ ] Add a device page explaining one-account/one-device behavior and route replacement/unbind requests to support.
- [ ] Expand the legal center with User Agreement, Privacy Policy, Account & Payment Security, Funds & Withdrawal Rules, and Responsible Entertainment & Risk Notice.
- [ ] Update privacy language to cover device identifiers, PIN hashes/lock records, financial logs, retention, correction/deletion requests, and support contact.
- [ ] Use restrained ivory surfaces, gold security accents, grouped rows, and a single strong security-status card; preserve existing visual language and accessibility.

### Task 6: Admin recovery, documentation, and verification

**Files:**
- Modify: `apps/admin/src/App.tsx`
- Modify: `docs/01-产品需求文档-PRD.md`
- Modify: `docs/04-账务与结算说明.md`
- Modify: `docs/05-系统架构说明.md`

- [ ] Show PIN status in user details and add a reason-confirmed reset action for authorized reviewers.
- [ ] Document mandatory post-KYC PIN setup, lockout rules, protected operations, recovery, and device-session invalidation.
- [ ] Generate Prisma Client and deploy the migration.
- [ ] Run focused red/green tests and the complete backend suite.
- [ ] Build backend, Mini App, and Admin.
- [ ] Verify migration status, backend readiness, PIN hashes are never serialized, and protected APIs cannot mutate funds without a valid PIN.

No git commit is included because the user did not request one.

-- Keep pending withdrawals in a user-owned frozen account until finance completes them.
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'USER_FREEZE_WITHDRAW';

ALTER TABLE "wallets"
ADD COLUMN IF NOT EXISTS "freeze_withdraw_cents" BIGINT NOT NULL DEFAULT 0;

-- Upgrade pre-release rows created by the former direct-to-clearing workflow.
UPDATE "wallets" AS wallet
SET "freeze_withdraw_cents" = pending.total_cents
FROM (
  SELECT "user_id", SUM("amount_cents") AS total_cents
  FROM "withdraw_orders"
  WHERE "status" = 'PENDING'
  GROUP BY "user_id"
) AS pending
WHERE wallet."user_id" = pending."user_id";

UPDATE "platform_accounts"
SET "balance_cents" = "balance_cents" - COALESCE(
  (
    SELECT SUM("amount_cents")
    FROM "withdraw_orders"
    WHERE "status" = 'PENDING'
  ),
  0
)
WHERE "account_type" = 'ADJUST_CLEARING';

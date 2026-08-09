-- Historical completed withdrawals credited the full gross amount to ADJUST_CLEARING.
-- Reclassify the stored fee portion into PLATFORM_FEES without changing user balances.
CREATE TEMP TABLE "_withdraw_fee_reclass" ON COMMIT DROP AS
SELECT
  withdrawal."id",
  (withdrawal."target_snapshot"->>'feeCents')::BIGINT AS "fee_cents",
  withdrawal."reviewed_by",
  COALESCE(withdrawal."reviewed_at", withdrawal."created_at") AS "recorded_at"
FROM "withdraw_orders" AS withdrawal
WHERE withdrawal."status" = 'COMPLETED'
  AND (withdrawal."target_snapshot"->>'feeCents') ~ '^[0-9]+$'
  AND (withdrawal."target_snapshot"->>'feeCents')::BIGINT > 0
  AND EXISTS (
    SELECT 1
    FROM "wallet_ledger" AS completion
    WHERE completion."idempotency_key" = CONCAT('withdraw-complete:', withdrawal."id", ':in')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "wallet_ledger" AS fee
    WHERE fee."ref_id" = withdrawal."id"
      AND fee."ref_type" IN ('withdraw_fee', 'withdraw_fee_reclass')
  );

UPDATE "platform_accounts"
SET
  "balance_cents" = "balance_cents" - COALESCE(
    (SELECT SUM("fee_cents") FROM "_withdraw_fee_reclass"),
    0
  ),
  "updated_at" = CURRENT_TIMESTAMP
WHERE "account_type" = 'ADJUST_CLEARING';

UPDATE "platform_accounts"
SET
  "balance_cents" = "balance_cents" + COALESCE(
    (SELECT SUM("fee_cents") FROM "_withdraw_fee_reclass"),
    0
  ),
  "updated_at" = CURRENT_TIMESTAMP
WHERE "account_type" = 'PLATFORM_FEES';

INSERT INTO "wallet_ledger" (
  "id",
  "user_id",
  "account_type",
  "direction",
  "amount_cents",
  "balance_after_cents",
  "ref_type",
  "ref_id",
  "idempotency_key",
  "operator_id",
  "memo",
  "created_at"
)
SELECT
  CONCAT('fee-reclass-out-', "id"),
  NULL,
  'ADJUST_CLEARING',
  'DEBIT',
  "fee_cents",
  NULL,
  'withdraw_fee_reclass',
  "id",
  CONCAT('withdraw-fee-reclass:', "id", ':out'),
  "reviewed_by",
  '历史提现手续费重分类',
  "recorded_at"
FROM "_withdraw_fee_reclass";

INSERT INTO "wallet_ledger" (
  "id",
  "user_id",
  "account_type",
  "direction",
  "amount_cents",
  "balance_after_cents",
  "ref_type",
  "ref_id",
  "idempotency_key",
  "operator_id",
  "memo",
  "created_at"
)
SELECT
  CONCAT('fee-reclass-in-', "id"),
  NULL,
  'PLATFORM_FEES',
  'CREDIT',
  "fee_cents",
  NULL,
  'withdraw_fee_reclass',
  "id",
  CONCAT('withdraw-fee-reclass:', "id", ':in'),
  "reviewed_by",
  '历史提现手续费重分类',
  "recorded_at"
FROM "_withdraw_fee_reclass";

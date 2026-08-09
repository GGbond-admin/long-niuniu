-- Reclassify the credit leg of pre-release pending withdrawals so ledger
-- ownership matches the migrated USER_FREEZE_WITHDRAW wallet balance.
UPDATE "wallet_ledger" AS ledger
SET
  "user_id" = withdrawal."user_id",
  "account_type" = 'USER_FREEZE_WITHDRAW',
  "balance_after_cents" = NULL
FROM "withdraw_orders" AS withdrawal
WHERE ledger."ref_type" = 'withdraw_freeze'
  AND ledger."ref_id" = withdrawal."id"
  AND ledger."direction" = 'CREDIT'
  AND ledger."account_type" = 'ADJUST_CLEARING'
  AND withdrawal."status" = 'PENDING';

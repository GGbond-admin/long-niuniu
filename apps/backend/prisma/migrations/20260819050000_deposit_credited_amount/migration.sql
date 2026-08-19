ALTER TABLE "deposit_orders"
ADD COLUMN "credited_amount_cents" BIGINT;

-- 已完成订单以用户侧充值入账流水为准回填；旧数据缺流水时才回退到实付/下单金额。
UPDATE "deposit_orders" AS deposit
SET "credited_amount_cents" = COALESCE(
  (
    SELECT entry."amount_cents"
    FROM "wallet_ledger" AS entry
    WHERE entry."user_id" = deposit."user_id"
      AND entry."ref_type" = 'deposit'
      AND entry."ref_id" = deposit."id"
      AND entry."direction" = 'CREDIT'
    ORDER BY entry."created_at" ASC
    LIMIT 1
  ),
  deposit."paid_amount_cents",
  deposit."amount_cents"
)
WHERE deposit."status" = 'COMPLETED';

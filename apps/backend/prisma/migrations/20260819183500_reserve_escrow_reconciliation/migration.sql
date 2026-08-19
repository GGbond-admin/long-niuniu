-- Reconcile legacy reserve overdrafts before enforcing the escrow invariant.
-- Group packets are fully prefunded; the reserve must at least cover every
-- currently active packet's unclaimed amount.

INSERT INTO "platform_accounts" (
  "id",
  "account_type",
  "balance_cents",
  "updated_at"
)
VALUES (
  'reserve-reconcile-20260819183500',
  'PLATFORM_RESERVE',
  0,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("account_type") DO NOTHING;

INSERT INTO "platform_accounts" (
  "id",
  "account_type",
  "balance_cents",
  "updated_at"
)
VALUES (
  'clearing-reconcile-20260819183500',
  'ADJUST_CLEARING',
  0,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("account_type") DO NOTHING;

DO $$
DECLARE
  reserve_before BIGINT;
  reserve_after BIGINT;
  clearing_after BIGINT;
  group_packet_obligations BIGINT;
  adjustment BIGINT;
BEGIN
  SELECT "balance_cents"
  INTO reserve_before
  FROM "platform_accounts"
  WHERE "account_type" = 'PLATFORM_RESERVE'
  FOR UPDATE;

  SELECT "balance_cents"
  INTO clearing_after
  FROM "platform_accounts"
  WHERE "account_type" = 'ADJUST_CLEARING'
  FOR UPDATE;

  SELECT COALESCE(SUM("remaining_cents"), 0)::BIGINT
  INTO group_packet_obligations
  FROM "group_packets"
  WHERE "status" = 'ACTIVE';

  adjustment := GREATEST(group_packet_obligations - reserve_before, 0);

  IF adjustment > 0 THEN
    UPDATE "platform_accounts"
    SET
      "balance_cents" = "balance_cents" - adjustment,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "account_type" = 'ADJUST_CLEARING'
    RETURNING "balance_cents" INTO clearing_after;

    INSERT INTO "wallet_ledger" (
      "id",
      "user_id",
      "account_type",
      "direction",
      "amount_cents",
      "balance_after_cents",
      "round_id",
      "ref_type",
      "ref_id",
      "idempotency_key",
      "operator_id",
      "memo",
      "created_at"
    )
    VALUES (
      'reserve-reconcile-out-20260819183500',
      NULL,
      'ADJUST_CLEARING',
      'DEBIT',
      adjustment,
      clearing_after,
      NULL,
      'reserve_reconciliation',
      '20260819183500',
      'reserve-reconciliation:20260819183500:out',
      NULL,
      '修复历史内部红包先领取、后收代包费造成的备付金透支',
      CURRENT_TIMESTAMP
    );

    UPDATE "platform_accounts"
    SET
      "balance_cents" = "balance_cents" + adjustment,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "account_type" = 'PLATFORM_RESERVE'
    RETURNING "balance_cents" INTO reserve_after;

    INSERT INTO "wallet_ledger" (
      "id",
      "user_id",
      "account_type",
      "direction",
      "amount_cents",
      "balance_after_cents",
      "round_id",
      "ref_type",
      "ref_id",
      "idempotency_key",
      "operator_id",
      "memo",
      "created_at"
    )
    VALUES (
      'reserve-reconcile-in-20260819183500',
      NULL,
      'PLATFORM_RESERVE',
      'CREDIT',
      adjustment,
      reserve_after,
      NULL,
      'reserve_reconciliation',
      '20260819183500',
      'reserve-reconciliation:20260819183500:in',
      NULL,
      '恢复活跃群红包未领取金额的足额托管',
      CURRENT_TIMESTAMP
    );
  END IF;
END
$$;

ALTER TABLE "platform_accounts"
  ADD CONSTRAINT "platform_accounts_reserve_nonnegative"
  CHECK (
    "account_type" <> 'PLATFORM_RESERVE'
    OR "balance_cents" >= 0
  ) NOT VALID;

ALTER TABLE "platform_accounts"
  VALIDATE CONSTRAINT "platform_accounts_reserve_nonnegative";

BEGIN;

-- Block legacy API/worker instances from paying internal or TNG packets before
-- the banker's frozen packet fee has funded PLATFORM_RESERVE. The trigger and
-- the reconciliation below become visible in the same commit.
CREATE OR REPLACE FUNCTION "enforce_packet_escrow_before_reserve_debit"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW."account_type" = 'PLATFORM_RESERVE'
    AND NEW."direction" = 'DEBIT'
    AND NEW."ref_type" IN ('packet_internal_claim', 'packet_create')
  ) THEN
    IF (
      NEW."round_id" IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM "wallet_ledger" AS fee
        INNER JOIN "packets" AS packet
          ON packet."round_id" = NEW."round_id"
        INNER JOIN "rounds" AS round_row
          ON round_row."id" = NEW."round_id"
        WHERE fee."idempotency_key" =
          'settle:fee_packet_agent:' || NEW."round_id" || ':out'
          AND fee."user_id" = round_row."banker_id"
          AND fee."account_type" = 'USER_FREEZE_BANKER'
          AND fee."direction" = 'DEBIT'
          AND fee."amount_cents" = packet."total_cents"
          AND fee."ref_type" = 'fee_packet_agent'
          AND fee."ref_id" = NEW."round_id"
          AND fee."round_id" = NEW."round_id"
      )
    ) THEN
      RAISE EXCEPTION
        'packet escrow must be funded before reserve debit for round %',
        NEW."round_id"
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'packet_escrow_funded_before_debit';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "wallet_ledger_packet_escrow_guard"
  ON "wallet_ledger";

CREATE TRIGGER "wallet_ledger_packet_escrow_guard"
BEFORE INSERT ON "wallet_ledger"
FOR EACH ROW
EXECUTE FUNCTION "enforce_packet_escrow_before_reserve_debit"();

INSERT INTO "platform_accounts" (
  "id",
  "account_type",
  "balance_cents",
  "updated_at"
)
VALUES (
  'reserve-cutover-20260819191500',
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
  'clearing-cutover-20260819191500',
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
      'reserve-cutover-out-20260819191500',
      NULL,
      'ADJUST_CLEARING',
      'DEBIT',
      adjustment,
      clearing_after,
      NULL,
      'reserve_reconciliation',
      '20260819191500',
      'reserve-reconciliation:20260819191500:out',
      NULL,
      '红包托管代码切换前的二次原子校准',
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
      'reserve-cutover-in-20260819191500',
      NULL,
      'PLATFORM_RESERVE',
      'CREDIT',
      adjustment,
      reserve_after,
      NULL,
      'reserve_reconciliation',
      '20260819191500',
      'reserve-reconciliation:20260819191500:in',
      NULL,
      '补足切换时所有活跃群红包未领取金额',
      CURRENT_TIMESTAMP
    );
  END IF;
END
$$;

COMMIT;

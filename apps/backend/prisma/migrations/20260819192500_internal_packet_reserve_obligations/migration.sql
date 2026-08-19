BEGIN;

-- Quiesce every table that can change packet obligations while the materialized
-- PLATFORM_RESERVE balance is calibrated.
LOCK TABLE "wallet_ledger", "group_packets", "packets", "claims"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  reserve_before BIGINT;
  reserve_after BIGINT;
  clearing_after BIGINT;
  group_packet_obligations BIGINT;
  internal_packet_obligations BIGINT;
  required_balance BIGINT;
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

  SELECT COALESCE(
    SUM(
      GREATEST(
        packet."total_cents" - COALESCE(claimed."amount_cents", 0),
        0
      )
    ),
    0
  )::BIGINT
  INTO internal_packet_obligations
  FROM "packets" AS packet
  INNER JOIN "rounds" AS round_row
    ON round_row."id" = packet."round_id"
  LEFT JOIN (
    SELECT
      "packet_id",
      SUM("amount_cents")::BIGINT AS "amount_cents"
    FROM "claims"
    GROUP BY "packet_id"
  ) AS claimed
    ON claimed."packet_id" = packet."id"
  WHERE packet."channel" = 'INTERNAL'
    AND packet."status" IN ('SENT', 'EXPIRED')
    AND EXISTS (
      SELECT 1
      FROM "wallet_ledger" AS fee
      WHERE fee."idempotency_key" =
        'settle:fee_packet_agent:' || packet."round_id" || ':out'
        AND fee."user_id" = round_row."banker_id"
        AND fee."account_type" = 'USER_FREEZE_BANKER'
        AND fee."direction" = 'DEBIT'
        AND fee."amount_cents" = packet."total_cents"
        AND fee."ref_type" = 'fee_packet_agent'
        AND fee."ref_id" = packet."round_id"
        AND fee."round_id" = packet."round_id"
    );

  required_balance := group_packet_obligations + internal_packet_obligations;
  adjustment := GREATEST(required_balance - reserve_before, 0);

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
      'reserve-obligations-out-20260819192500',
      NULL,
      'ADJUST_CLEARING',
      'DEBIT',
      adjustment,
      clearing_after,
      NULL,
      'reserve_reconciliation',
      '20260819192500',
      'reserve-reconciliation:20260819192500:out',
      NULL,
      '补足群红包及已预付站内红包的全部未领取义务',
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
      'reserve-obligations-in-20260819192500',
      NULL,
      'PLATFORM_RESERVE',
      'CREDIT',
      adjustment,
      reserve_after,
      NULL,
      'reserve_reconciliation',
      '20260819192500',
      'reserve-reconciliation:20260819192500:in',
      NULL,
      '完成红包备付金全义务原子校准',
      CURRENT_TIMESTAMP
    );
  END IF;
END
$$;

COMMIT;

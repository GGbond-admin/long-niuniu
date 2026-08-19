-- DOCX 称桶流程：按单房间连续局号区间生成、永久锁局、完整代理快照、两阶段发放。
-- 旧 profit_pool_daily / agent_profit_shares 保留为只读历史。

BEGIN;

-- Wait for any in-flight legacy settlement transaction, then block all further writes
-- until the preflight, cutover calculation, and read-only triggers are committed together.
LOCK TABLE "profit_pool_daily", "agent_profit_shares"
  IN SHARE ROW EXCLUSIVE MODE;

-- This cutover is intentionally fail-closed. Every old two-stage report must be
-- either confirmed or discarded while the legacy application can still do so.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "profit_pool_daily"
    WHERE "status" = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'legacy pending profit pools must be resolved before cutover'
      USING HINT =
        'Confirm paid reports or discard unpaid reports before running this migration.';
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "ProfitPoolBatchStatus" AS ENUM ('PENDING', 'DISTRIBUTED', 'NO_DISTRIBUTION');

CREATE TABLE "profit_pool_batches" (
    "id" TEXT NOT NULL,
    "pool_code" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "start_seq_no" INTEGER NOT NULL,
    "end_seq_no" INTEGER NOT NULL,
    "round_count" INTEGER NOT NULL,
    "finished_round_count" INTEGER NOT NULL,
    "cancelled_round_count" INTEGER NOT NULL DEFAULT 0,
    "turnover_player_cents" BIGINT NOT NULL DEFAULT 0,
    "turnover_banker_cents" BIGINT NOT NULL DEFAULT 0,
    "turnover_cents" BIGINT NOT NULL,
    "rake_player_cents" BIGINT NOT NULL DEFAULT 0,
    "rake_banker_cents" BIGINT NOT NULL DEFAULT 0,
    "rake_total_cents" BIGINT NOT NULL,
    "expense_bps" INTEGER NOT NULL,
    "expense_cents" BIGINT NOT NULL,
    "net_pool_cents" BIGINT NOT NULL,
    "distributed_cents" BIGINT NOT NULL DEFAULT 0,
    "residual_cents" BIGINT NOT NULL DEFAULT 0,
    "bucket_base_snapshot" INTEGER NOT NULL,
    "calculation_hash" TEXT NOT NULL,
    "status" "ProfitPoolBatchStatus" NOT NULL DEFAULT 'PENDING',
    "generated_by" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "distributed_by" TEXT,
    "distributed_at" TIMESTAMP(3),

    CONSTRAINT "profit_pool_batches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "profit_pool_batches_range_check"
      CHECK ("start_seq_no" > 0 AND "end_seq_no" >= "start_seq_no"),
    CONSTRAINT "profit_pool_batches_round_count_check"
      CHECK ("round_count" = "end_seq_no" - "start_seq_no" + 1),
    CONSTRAINT "profit_pool_batches_expense_bps_check"
      CHECK ("expense_bps" BETWEEN 0 AND 10000),
    CONSTRAINT "profit_pool_batches_terminal_counts_check"
      CHECK (
        "finished_round_count" >= 0
        AND "cancelled_round_count" >= 0
        AND "finished_round_count" + "cancelled_round_count" = "round_count"
      ),
    CONSTRAINT "profit_pool_batches_money_check"
      CHECK (
        "turnover_player_cents" >= 0
        AND "turnover_banker_cents" >= 0
        AND "turnover_cents" >= 0
        AND "rake_player_cents" >= 0
        AND "rake_banker_cents" >= 0
        AND "rake_total_cents" >= 0
        AND "expense_cents" >= 0
        AND "turnover_cents" = "turnover_player_cents" + "turnover_banker_cents"
        AND "rake_total_cents" = "rake_player_cents" + "rake_banker_cents"
        AND "net_pool_cents" = "rake_total_cents" - "expense_cents"
        AND "distributed_cents" >= 0
        AND "residual_cents" >= 0
        AND "distributed_cents" <= GREATEST("net_pool_cents", 0)
        AND "distributed_cents" + "residual_cents" = GREATEST("net_pool_cents", 0)
        AND "bucket_base_snapshot" > 0
      )
);

CREATE TABLE "profit_pool_round_locks" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "seq_no" INTEGER NOT NULL,
    "phase_snapshot" TEXT NOT NULL,
    "finished_at_snapshot" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profit_pool_round_locks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "profit_pool_agent_snapshots" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "source_agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "parent_source_agent_id" TEXT,
    "label" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "nickname" TEXT,
    "avatar_url" TEXT,
    "level" INTEGER NOT NULL,
    "status_snapshot" TEXT NOT NULL,
    "share_points_snapshot" INTEGER NOT NULL,
    "bucket_base_snapshot" INTEGER NOT NULL,
    "direct_agent_count" INTEGER NOT NULL DEFAULT 0,
    "team_agent_count" INTEGER NOT NULL DEFAULT 0,
    "direct_player_count" INTEGER NOT NULL DEFAULT 0,
    "team_player_count" INTEGER NOT NULL DEFAULT 0,
    "self_turnover_cents" BIGINT NOT NULL DEFAULT 0,
    "team_turnover_cents" BIGINT NOT NULL DEFAULT 0,
    "contribution_bp" INTEGER NOT NULL DEFAULT 0,
    "self_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "override_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "amount_cents" BIGINT NOT NULL DEFAULT 0,
    "breakdown" JSONB,
    "ledger_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profit_pool_agent_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "profit_pool_agent_snapshots_values_check"
      CHECK (
        "level" >= 0
        AND "share_points_snapshot" BETWEEN 0 AND "bucket_base_snapshot"
        AND "bucket_base_snapshot" > 0
        AND "direct_agent_count" >= 0
        AND "team_agent_count" >= 0
        AND "direct_player_count" >= 0
        AND "team_player_count" >= 0
        AND "self_turnover_cents" >= 0
        AND "team_turnover_cents" >= "self_turnover_cents"
        AND "contribution_bp" BETWEEN 0 AND 10000
        AND "self_amount_cents" >= 0
        AND "override_amount_cents" >= 0
        AND "amount_cents" = "self_amount_cents" + "override_amount_cents"
      )
);

CREATE TABLE "profit_pool_player_snapshots" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "source_agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "nickname" TEXT,
    "avatar_url" TEXT,
    "binding_source" TEXT NOT NULL,
    "is_agent_self" BOOLEAN NOT NULL DEFAULT false,
    "turnover_cents" BIGINT NOT NULL DEFAULT 0,
    "profit_cents" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profit_pool_player_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "profit_pool_player_snapshots_money_check"
      CHECK ("turnover_cents" >= 0 AND "profit_cents" >= 0)
);

CREATE TABLE "profit_pool_cutovers" (
    "room_id" TEXT NOT NULL,
    "max_seq_no" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'LEGACY_DAILY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profit_pool_cutovers_pkey" PRIMARY KEY ("room_id"),
    CONSTRAINT "profit_pool_cutovers_seq_check" CHECK ("max_seq_no" >= 0)
);

CREATE TABLE "profit_pool_sequences" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profit_pool_sequences_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "profit_pool_batches_pool_code_key"
  ON "profit_pool_batches"("pool_code");
CREATE INDEX "profit_pool_batches_room_id_start_seq_no_end_seq_no_idx"
  ON "profit_pool_batches"("room_id", "start_seq_no", "end_seq_no");
CREATE INDEX "profit_pool_batches_status_generated_at_idx"
  ON "profit_pool_batches"("status", "generated_at");
CREATE INDEX "profit_pool_batches_generated_at_idx"
  ON "profit_pool_batches"("generated_at");

-- Prisma schema 尚不能声明 exclusion constraint；此约束与逐局唯一锁共同防止并发区间重叠。
ALTER TABLE "profit_pool_batches"
  ADD CONSTRAINT "profit_pool_batches_room_seq_range_excl"
  EXCLUDE USING gist (
    "room_id" WITH =,
    int4range("start_seq_no", "end_seq_no", '[]') WITH &&
  );

CREATE UNIQUE INDEX "profit_pool_round_locks_round_id_key"
  ON "profit_pool_round_locks"("round_id");
CREATE UNIQUE INDEX "profit_pool_round_locks_room_id_seq_no_key"
  ON "profit_pool_round_locks"("room_id", "seq_no");
CREATE INDEX "profit_pool_round_locks_pool_id_seq_no_idx"
  ON "profit_pool_round_locks"("pool_id", "seq_no");

CREATE UNIQUE INDEX "profit_pool_agent_snapshots_ledger_ref_key"
  ON "profit_pool_agent_snapshots"("ledger_ref");
CREATE UNIQUE INDEX "profit_pool_agent_snapshots_pool_id_source_agent_id_key"
  ON "profit_pool_agent_snapshots"("pool_id", "source_agent_id");
CREATE INDEX "profit_pool_agent_snapshots_source_agent_id_pool_id_idx"
  ON "profit_pool_agent_snapshots"("source_agent_id", "pool_id");
CREATE INDEX "profit_pool_agent_snapshots_pool_id_parent_source_agent_id_idx"
  ON "profit_pool_agent_snapshots"("pool_id", "parent_source_agent_id");

CREATE UNIQUE INDEX "profit_pool_player_snapshots_pool_id_user_id_key"
  ON "profit_pool_player_snapshots"("pool_id", "user_id");
CREATE INDEX "profit_pool_player_snapshots_pool_id_source_agent_id_idx"
  ON "profit_pool_player_snapshots"("pool_id", "source_agent_id");

CREATE INDEX "room_members_user_id_status_last_seen_at_idx"
  ON "room_members"("user_id", "status", "last_seen_at");

ALTER TABLE "profit_pool_batches"
  ADD CONSTRAINT "profit_pool_batches_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "profit_pool_round_locks"
  ADD CONSTRAINT "profit_pool_round_locks_pool_id_fkey"
  FOREIGN KEY ("pool_id") REFERENCES "profit_pool_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "profit_pool_round_locks"
  ADD CONSTRAINT "profit_pool_round_locks_round_id_fkey"
  FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "profit_pool_agent_snapshots"
  ADD CONSTRAINT "profit_pool_agent_snapshots_pool_id_fkey"
  FOREIGN KEY ("pool_id") REFERENCES "profit_pool_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "profit_pool_player_snapshots"
  ADD CONSTRAINT "profit_pool_player_snapshots_pool_id_fkey"
  FOREIGN KEY ("pool_id") REFERENCES "profit_pool_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "profit_pool_cutovers"
  ADD CONSTRAINT "profit_pool_cutovers_room_id_fkey"
  FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Block exactly the sequence prefix containing rounds that contributed to a finalized
-- legacy day. Legacy rake was grouped by Settlement.createdAt; Round.settledAt is also
-- included defensively because turnover used the settlement transaction's Malaysia day.
-- Taking MAX(seq_no) per room additionally absorbs zero-value/cancelled gaps before it.
WITH "finalized_legacy_days" AS (
  SELECT "date"
  FROM "profit_pool_daily"
  WHERE "status" IN ('SETTLED', 'NO_DISTRIBUTION')
),
"legacy_covered_rounds" AS (
  SELECT DISTINCT r."room_id", r."seq_no"
  FROM "rounds" r
  JOIN "settlements" s ON s."round_id" = r."id"
  JOIN "finalized_legacy_days" d
    ON (
      s."created_at" >= d."date"::date::timestamp - INTERVAL '8 hours'
      AND s."created_at" < (d."date"::date + 1)::timestamp - INTERVAL '8 hours'
    )
    OR (
      r."settled_at" IS NOT NULL
      AND r."settled_at" >= d."date"::date::timestamp - INTERVAL '8 hours'
      AND r."settled_at" < (d."date"::date + 1)::timestamp - INTERVAL '8 hours'
    )
)
INSERT INTO "profit_pool_cutovers" ("room_id", "max_seq_no", "source")
SELECT "room_id", MAX("seq_no"), 'LEGACY_DAILY'
FROM "legacy_covered_rounds"
GROUP BY "room_id"
ON CONFLICT ("room_id") DO NOTHING;

-- From this cutover onward the legacy daily tables are read-only. This database guard
-- also blocks an older application instance from generating or confirming another daily
-- pool while the new round-range deployment is rolling out. The guarded PENDING delete
-- path remains only as defense-in-depth for manually repaired databases.
CREATE FUNCTION "reject_legacy_profit_pool_write"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'legacy profit pool is read-only after round-range cutover'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "profit_pool_daily_write_block_after_cutover"
BEFORE INSERT OR UPDATE ON "profit_pool_daily"
FOR EACH ROW
EXECUTE FUNCTION "reject_legacy_profit_pool_write"();

CREATE TRIGGER "agent_profit_shares_write_block_after_cutover"
BEFORE INSERT OR UPDATE ON "agent_profit_shares"
FOR EACH ROW
EXECUTE FUNCTION "reject_legacy_profit_pool_write"();

CREATE FUNCTION "guard_legacy_profit_pool_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status TEXT;
BEGIN
  IF current_setting('app.allow_legacy_pending_discard', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'legacy profit pool deletion requires the pending-discard workflow'
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'profit_pool_daily' THEN
    IF OLD."status" = 'PENDING' THEN
      RETURN OLD;
    END IF;
  ELSE
    SELECT "status" INTO parent_status
    FROM "profit_pool_daily"
    WHERE "id" = OLD."pool_id";
    IF parent_status = 'PENDING' THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'settled legacy profit pool history is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "profit_pool_daily_delete_guard_after_cutover"
BEFORE DELETE ON "profit_pool_daily"
FOR EACH ROW
EXECUTE FUNCTION "guard_legacy_profit_pool_delete"();

CREATE TRIGGER "agent_profit_shares_delete_guard_after_cutover"
BEFORE DELETE ON "agent_profit_shares"
FOR EACH ROW
EXECUTE FUNCTION "guard_legacy_profit_pool_delete"();

COMMIT;

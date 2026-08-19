-- Game-scoped Mini App administrators, shared packet budgets, and room moderation.

CREATE TYPE "GameAdminAssignmentStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "GroupPacketFundingSource" AS ENUM ('USER_WALLET', 'GAME_BUDGET');

CREATE TABLE "game_admin_assignments" (
    "id" TEXT NOT NULL,
    "game_code" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "GameAdminAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_admin_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "game_budget_accounts" (
    "id" TEXT NOT NULL,
    "game_code" TEXT NOT NULL,
    "balance_cents" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_budget_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "game_budget_accounts_balance_nonnegative"
      CHECK ("balance_cents" >= 0)
);

CREATE TABLE "game_budget_ledger" (
    "id" TEXT NOT NULL,
    "budget_account_id" TEXT NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "balance_after_cents" BIGINT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "platform_admin_id" TEXT,
    "game_admin_assignment_id" TEXT,
    "memo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_budget_ledger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "game_budget_ledger_amount_positive"
      CHECK ("amount_cents" > 0),
    CONSTRAINT "game_budget_ledger_balance_nonnegative"
      CHECK ("balance_after_cents" >= 0)
);

CREATE TABLE "game_admin_action_logs" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "game_code" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_user_id" TEXT,
    "packet_id" TEXT,
    "idempotency_key" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_admin_action_logs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "room_members"
  ADD COLUMN "chat_muted_at" TIMESTAMP(3),
  ADD COLUMN "chat_muted_until" TIMESTAMP(3),
  ADD COLUMN "chat_mute_reason" TEXT,
  ADD COLUMN "chat_muted_by_assignment_id" TEXT;

ALTER TABLE "room_members"
  ADD CONSTRAINT "room_members_chat_mute_consistent"
  CHECK (
    "chat_muted_at" IS NOT NULL
    OR (
      "chat_muted_until" IS NULL
      AND "chat_mute_reason" IS NULL
      AND "chat_muted_by_assignment_id" IS NULL
    )
  );

ALTER TABLE "group_packets"
  ADD COLUMN "funding_source" "GroupPacketFundingSource" NOT NULL DEFAULT 'USER_WALLET',
  ADD COLUMN "budget_account_id" TEXT,
  ADD COLUMN "game_admin_assignment_id" TEXT;

ALTER TABLE "group_packets"
  ADD CONSTRAINT "group_packets_funding_source_consistent"
  CHECK (
    (
      "funding_source" = 'USER_WALLET'
      AND "budget_account_id" IS NULL
      AND "game_admin_assignment_id" IS NULL
    )
    OR
    (
      "funding_source" = 'GAME_BUDGET'
      AND "budget_account_id" IS NOT NULL
      AND "game_admin_assignment_id" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "game_admin_assignments_game_code_user_id_key"
  ON "game_admin_assignments"("game_code", "user_id");
CREATE INDEX "game_admin_assignments_user_id_status_idx"
  ON "game_admin_assignments"("user_id", "status");
CREATE INDEX "game_admin_assignments_game_code_status_idx"
  ON "game_admin_assignments"("game_code", "status");

CREATE UNIQUE INDEX "game_budget_accounts_game_code_key"
  ON "game_budget_accounts"("game_code");

CREATE UNIQUE INDEX "game_budget_ledger_idempotency_key_key"
  ON "game_budget_ledger"("idempotency_key");
CREATE INDEX "game_budget_ledger_budget_account_id_created_at_idx"
  ON "game_budget_ledger"("budget_account_id", "created_at");
CREATE INDEX "game_budget_ledger_game_admin_assignment_id_created_at_idx"
  ON "game_budget_ledger"("game_admin_assignment_id", "created_at");

CREATE UNIQUE INDEX "game_admin_action_logs_idempotency_key_key"
  ON "game_admin_action_logs"("idempotency_key");
CREATE INDEX "game_admin_action_logs_game_code_created_at_idx"
  ON "game_admin_action_logs"("game_code", "created_at");
CREATE INDEX "game_admin_action_logs_assignment_id_created_at_idx"
  ON "game_admin_action_logs"("assignment_id", "created_at");
CREATE INDEX "game_admin_action_logs_target_user_id_created_at_idx"
  ON "game_admin_action_logs"("target_user_id", "created_at");

CREATE INDEX "group_packets_budget_account_id_created_at_idx"
  ON "group_packets"("budget_account_id", "created_at");
CREATE INDEX "group_packets_game_admin_assignment_id_created_at_idx"
  ON "group_packets"("game_admin_assignment_id", "created_at");

ALTER TABLE "game_admin_assignments"
  ADD CONSTRAINT "game_admin_assignments_game_code_fkey"
  FOREIGN KEY ("game_code") REFERENCES "rooms"("game_code")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_admin_assignments"
  ADD CONSTRAINT "game_admin_assignments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "game_budget_accounts"
  ADD CONSTRAINT "game_budget_accounts_game_code_fkey"
  FOREIGN KEY ("game_code") REFERENCES "rooms"("game_code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "game_budget_ledger"
  ADD CONSTRAINT "game_budget_ledger_budget_account_id_fkey"
  FOREIGN KEY ("budget_account_id") REFERENCES "game_budget_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_budget_ledger"
  ADD CONSTRAINT "game_budget_ledger_game_admin_assignment_id_fkey"
  FOREIGN KEY ("game_admin_assignment_id") REFERENCES "game_admin_assignments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "game_admin_action_logs"
  ADD CONSTRAINT "game_admin_action_logs_assignment_id_fkey"
  FOREIGN KEY ("assignment_id") REFERENCES "game_admin_assignments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_admin_action_logs"
  ADD CONSTRAINT "game_admin_action_logs_target_user_id_fkey"
  FOREIGN KEY ("target_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "room_members"
  ADD CONSTRAINT "room_members_chat_muted_by_assignment_id_fkey"
  FOREIGN KEY ("chat_muted_by_assignment_id") REFERENCES "game_admin_assignments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "group_packets"
  ADD CONSTRAINT "group_packets_budget_account_id_fkey"
  FOREIGN KEY ("budget_account_id") REFERENCES "game_budget_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "group_packets"
  ADD CONSTRAINT "group_packets_game_admin_assignment_id_fkey"
  FOREIGN KEY ("game_admin_assignment_id") REFERENCES "game_admin_assignments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

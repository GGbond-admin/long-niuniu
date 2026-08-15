-- AlterEnum: 平台利润池科目（称桶分配出账账户）
ALTER TYPE "AccountType" ADD VALUE 'PLATFORM_PROFIT_POOL';

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable: 代理/股东
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "share_points" INTEGER NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agents_user_id_key" ON "agents"("user_id");
CREATE INDEX "agents_status_idx" ON "agents"("status");

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: 玩家归属
CREATE TABLE "agent_players" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "bound_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bound_by" TEXT,

    CONSTRAINT "agent_players_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_players_user_id_key" ON "agent_players"("user_id");
CREATE INDEX "agent_players_agent_id_idx" ON "agent_players"("agent_id");

ALTER TABLE "agent_players"
  ADD CONSTRAINT "agent_players_agent_id_fkey" FOREIGN KEY ("agent_id")
  REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_players"
  ADD CONSTRAINT "agent_players_user_id_fkey" FOREIGN KEY ("user_id")
  REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: 每日利润池
CREATE TABLE "profit_pool_daily" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "rake_player_cents" BIGINT NOT NULL DEFAULT 0,
    "rake_banker_cents" BIGINT NOT NULL DEFAULT 0,
    "rake_total_cents" BIGINT NOT NULL,
    "turnover_cents" BIGINT NOT NULL,
    "expense_ratio_snapshot" DOUBLE PRECISION NOT NULL,
    "expense_cents" BIGINT NOT NULL,
    "carry_in_cents" BIGINT NOT NULL DEFAULT 0,
    "net_pool_cents" BIGINT NOT NULL,
    "distributed_cents" BIGINT NOT NULL DEFAULT 0,
    "residual_cents" BIGINT NOT NULL DEFAULT 0,
    "carry_out_cents" BIGINT NOT NULL DEFAULT 0,
    "bucket_base_snapshot" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SETTLED',
    "settled_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profit_pool_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "profit_pool_daily_date_key" ON "profit_pool_daily"("date");
CREATE INDEX "profit_pool_daily_date_idx" ON "profit_pool_daily"("date");

-- CreateTable: 代理称桶分配明细
CREATE TABLE "agent_profit_shares" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "turnover_cents" BIGINT NOT NULL,
    "company_turnover_cents" BIGINT NOT NULL,
    "share_points_snapshot" INTEGER NOT NULL,
    "bucket_base_snapshot" INTEGER NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "ledger_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_profit_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_profit_shares_date_agent_id_key" ON "agent_profit_shares"("date", "agent_id");
CREATE INDEX "agent_profit_shares_agent_id_date_idx" ON "agent_profit_shares"("agent_id", "date");

ALTER TABLE "agent_profit_shares"
  ADD CONSTRAINT "agent_profit_shares_pool_id_fkey" FOREIGN KEY ("pool_id")
  REFERENCES "profit_pool_daily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_profit_shares"
  ADD CONSTRAINT "agent_profit_shares_agent_id_fkey" FOREIGN KEY ("agent_id")
  REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

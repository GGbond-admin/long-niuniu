-- 代理称桶制度升级：代理树（上下级）+ 占成差额分成 + 两阶段结算（生成 → 确认发放）

-- Agent：上级代理（自引用树）与建立者
ALTER TABLE "agents" ADD COLUMN "parent_agent_id" TEXT;
ALTER TABLE "agents" ADD COLUMN "created_by" TEXT;
CREATE INDEX "agents_parent_agent_id_idx" ON "agents"("parent_agent_id");
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_parent_agent_id_fkey" FOREIGN KEY ("parent_agent_id")
  REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AgentPlayer：归属来源（MANUAL 后台手动 / REFERRAL 推荐注册自动）
ALTER TABLE "agent_players" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';

-- ProfitPoolDaily：两阶段结算（PENDING 待确认 → SETTLED 已发放）
ALTER TABLE "profit_pool_daily" ADD COLUMN "confirmed_by" TEXT;
ALTER TABLE "profit_pool_daily" ADD COLUMN "confirmed_at" TIMESTAMP(3);
-- 历史池均为旧流程一步结算，视为已确认
UPDATE "profit_pool_daily" SET "confirmed_by" = "settled_by", "confirmed_at" = "created_at"
  WHERE "status" = 'SETTLED';

-- AgentProfitShare：自身/差额拆分与团队流水
ALTER TABLE "agent_profit_shares" ADD COLUMN "team_turnover_cents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "agent_profit_shares" ADD COLUMN "self_amount_cents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "agent_profit_shares" ADD COLUMN "override_amount_cents" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "agent_profit_shares" ADD COLUMN "breakdown" JSONB;
-- 历史明细（平面制）：全部视为自身利润，团队流水 = 自身流水
UPDATE "agent_profit_shares"
  SET "self_amount_cents" = "amount_cents", "team_turnover_cents" = "turnover_cents";

-- 将原有单游戏全局配置无损归入至尊牛牛命名空间。
ALTER TABLE "game_configs"
ADD COLUMN "game_code" TEXT NOT NULL DEFAULT 'SUPREME_NIUNIU';

ALTER TABLE "reward_configs"
ADD COLUMN "game_code" TEXT NOT NULL DEFAULT 'SUPREME_NIUNIU';

ALTER TABLE "daily_hand_progress"
ADD COLUMN "game_code" TEXT NOT NULL DEFAULT 'SUPREME_NIUNIU';

ALTER TABLE "leaderboards"
ADD COLUMN "game_code" TEXT NOT NULL DEFAULT 'SUPREME_NIUNIU';

ALTER TABLE "turnover_daily"
ADD COLUMN "game_code" TEXT NOT NULL DEFAULT 'SUPREME_NIUNIU';

ALTER TABLE "rebate_settlements"
ADD COLUMN "game_code" TEXT NOT NULL DEFAULT 'SUPREME_NIUNIU';

-- 提现配置属于平台，不归任何单一游戏。
UPDATE "game_configs"
SET "game_code" = 'PLATFORM'
WHERE "key" = 'withdraw';

UPDATE "game_configs"
SET "value" = jsonb_set(
  COALESCE("value", '{}'::jsonb),
  '{pointsMetric}',
  '"turnover"'::jsonb,
  true
)
WHERE "key" = 'leaderboard';

DROP INDEX IF EXISTS "game_configs_key_key";
DROP INDEX IF EXISTS "reward_configs_code_key";
DROP INDEX IF EXISTS "daily_hand_progress_user_id_date_key";
DROP INDEX IF EXISTS "leaderboards_type_period_period_key_key";
DROP INDEX IF EXISTS "turnover_daily_user_id_date_key";
DROP INDEX IF EXISTS "rebate_settlements_user_id_date_key";

CREATE UNIQUE INDEX "game_configs_game_code_key_key"
ON "game_configs"("game_code", "key");
CREATE INDEX "game_configs_game_code_idx"
ON "game_configs"("game_code");

CREATE UNIQUE INDEX "reward_configs_game_code_code_key"
ON "reward_configs"("game_code", "code");
CREATE INDEX "reward_configs_game_code_status_idx"
ON "reward_configs"("game_code", "status");

CREATE UNIQUE INDEX "daily_hand_progress_game_code_user_id_date_key"
ON "daily_hand_progress"("game_code", "user_id", "date");
CREATE INDEX "daily_hand_progress_game_code_date_idx"
ON "daily_hand_progress"("game_code", "date");

CREATE UNIQUE INDEX "leaderboards_game_code_type_period_period_key_key"
ON "leaderboards"("game_code", "type", "period", "period_key");
CREATE INDEX "leaderboards_game_code_period_period_key_idx"
ON "leaderboards"("game_code", "period", "period_key");

CREATE UNIQUE INDEX "turnover_daily_game_code_user_id_date_key"
ON "turnover_daily"("game_code", "user_id", "date");
CREATE INDEX "turnover_daily_game_code_date_idx"
ON "turnover_daily"("game_code", "date");

CREATE UNIQUE INDEX "rebate_settlements_game_code_user_id_date_key"
ON "rebate_settlements"("game_code", "user_id", "date");
CREATE INDEX "rebate_settlements_game_code_date_idx"
ON "rebate_settlements"("game_code", "date");

CREATE TABLE "game_rule_documents" (
  "id" TEXT NOT NULL,
  "game_code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "sections" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by" TEXT,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "game_rule_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "game_rule_documents_game_code_key"
ON "game_rule_documents"("game_code");
CREATE INDEX "game_rule_documents_status_idx"
ON "game_rule_documents"("status");

INSERT INTO "game_rule_documents" (
  "id",
  "game_code",
  "title",
  "summary",
  "sections",
  "status",
  "published_at"
)
VALUES (
  'game_rule_supreme_niuniu',
  'SUPREME_NIUNIU',
  '至尊牛牛游戏规则',
  '抢红包比牌型，庄闲实时结算。所有资金数值以开局时冻结的游戏配置为准。',
  '[
    {"id":"flow","title":"游戏流程","body":"竞标庄家 → 玩家下注 → 庄家投骰 → 发放红包 → 玩家抢包 → 系统按牌型自动结算。"},
    {"id":"hands","title":"牌型与大小","body":"系统根据红包金额尾数计算牛牛牌型；同牌型按点数及既定优先级比较，具体倍数以本页实时配置为准。"},
    {"id":"betting","title":"下注与梭哈","body":"仅在下注阶段接受操作。普通下注、梭哈范围及竞标上下限由当前游戏配置决定，封盘后不可修改。"},
    {"id":"settlement","title":"结算与费用","body":"余额先冻结后结算，取消局原路退回。玩家盈利抽水、庄家盈利抽水及相关费用以本局配置快照为准。"},
    {"id":"fairness","title":"公平与风险提示","body":"每局开始时冻结规则快照，后台后续修改只影响下一局。请理性参与并妥善保管账户及支付密码。"}
  ]'::jsonb,
  'PUBLISHED',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("game_code") DO NOTHING;

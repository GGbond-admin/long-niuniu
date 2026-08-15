-- AlterTable: 下注时预留本局最高倍数对应的最大赔付金额。
-- 部署要求：执行前须排空并停止所有旧版 API/Worker，禁止新旧版本滚动混跑。
ALTER TABLE "bets"
ADD COLUMN "reserved_cents" BIGINT NOT NULL DEFAULT 0;

-- 兼容部署时仍在进行中的旧下注：旧系统实际只冻结了下注本金。
UPDATE "bets"
SET "reserved_cents" = "amount_cents"
WHERE "reserved_cents" = 0;

-- AlterTable: 虚拟玩家新增“可抢群红包”能力开关
ALTER TABLE "virtual_players"
  ADD COLUMN "can_claim_group_packet" BOOLEAN NOT NULL DEFAULT true;

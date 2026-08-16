-- AlterTable: 玩家自助换绑设备（7 天限一次，换绑后 24 小时暂停提现）
ALTER TABLE "devices" ADD COLUMN "last_self_rebind_at" TIMESTAMP(3);

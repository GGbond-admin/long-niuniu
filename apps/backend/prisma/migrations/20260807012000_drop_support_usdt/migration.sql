-- 客服 USDT 地址留存功能下线，移除相关字段与枚举
ALTER TABLE "users" DROP COLUMN IF EXISTS "usdt_address";
ALTER TABLE "users" DROP COLUMN IF EXISTS "usdt_network";
ALTER TABLE "users" DROP COLUMN IF EXISTS "usdt_status";
ALTER TABLE "users" DROP COLUMN IF EXISTS "usdt_note";
ALTER TABLE "users" DROP COLUMN IF EXISTS "usdt_updated_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "usdt_updated_by";

DROP TYPE IF EXISTS "UsdtStatus";

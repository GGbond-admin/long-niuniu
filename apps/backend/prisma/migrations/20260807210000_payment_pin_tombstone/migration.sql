-- 保留重置后的支付密码凭证行，让 version 跨重置/重设持续单调递增。
ALTER TABLE "payment_pins"
ADD COLUMN "is_set" BOOLEAN NOT NULL DEFAULT true;

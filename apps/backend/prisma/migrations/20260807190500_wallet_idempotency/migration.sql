ALTER TABLE "deposit_orders" ADD COLUMN "request_id" TEXT;
UPDATE "deposit_orders" SET "request_id" = "id" WHERE "request_id" IS NULL;
ALTER TABLE "deposit_orders" ALTER COLUMN "request_id" SET NOT NULL;

ALTER TABLE "withdraw_orders" ADD COLUMN "request_id" TEXT;
UPDATE "withdraw_orders" SET "request_id" = "id" WHERE "request_id" IS NULL;
ALTER TABLE "withdraw_orders" ALTER COLUMN "request_id" SET NOT NULL;

CREATE UNIQUE INDEX "deposit_orders_user_id_request_id_key"
ON "deposit_orders"("user_id", "request_id");

CREATE UNIQUE INDEX "withdraw_orders_user_id_request_id_key"
ON "withdraw_orders"("user_id", "request_id");

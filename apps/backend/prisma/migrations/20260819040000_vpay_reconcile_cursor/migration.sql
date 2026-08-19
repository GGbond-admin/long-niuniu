ALTER TABLE "deposit_orders"
ADD COLUMN "provider_checked_at" TIMESTAMP(3);

CREATE INDEX "deposit_orders_channel_status_provider_checked_at_idx"
ON "deposit_orders"("channel", "status", "provider_checked_at");

-- CreateEnum
CREATE TYPE "DepositChannel" AS ENUM ('MANUAL', 'VPAY');

-- AlterTable
ALTER TABLE "deposit_orders"
  ADD COLUMN "channel" "DepositChannel" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "provider_trade_no" TEXT,
  ADD COLUMN "provider_code" TEXT,
  ADD COLUMN "pay_url" TEXT,
  ADD COLUMN "expired_at" TIMESTAMP(3),
  ADD COLUMN "paid_amount_cents" BIGINT,
  ADD COLUMN "provider_payload" JSONB;

-- CreateIndex
CREATE INDEX "deposit_orders_channel_status_idx" ON "deposit_orders"("channel", "status");

-- CreateTable
CREATE TABLE "payment_provider_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "base_url" TEXT NOT NULL DEFAULT '',
    "trader_id" TEXT NOT NULL DEFAULT '',
    "api_token" TEXT NOT NULL DEFAULT '',
    "trade_codes" JSONB NOT NULL DEFAULT '[]',
    "notify_ips" JSONB NOT NULL DEFAULT '[]',
    "timezone_offset_minutes" INTEGER NOT NULL DEFAULT 480,
    "notify_url" TEXT NOT NULL DEFAULT '',
    "callback_url" TEXT NOT NULL DEFAULT '',
    "order_title" TEXT NOT NULL DEFAULT 'Deposit',
    "min_amount_cents" BIGINT NOT NULL DEFAULT 10000,
    "max_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_configs_provider_key" ON "payment_provider_configs"("provider");

-- CreateEnum
CREATE TYPE "TngClaimInboxStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISCARDED');

-- AlterTable
ALTER TABLE "packets" ADD COLUMN "deep_link" TEXT;
ALTER TABLE "packets" ADD COLUMN "correlation" TEXT;
ALTER TABLE "packets" ADD COLUMN "ingest_device_id" TEXT;
ALTER TABLE "packets" ADD COLUMN "ingest_lease_until" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "packets_correlation_key" ON "packets"("correlation");

-- CreateTable
CREATE TABLE "tng_claim_inbox" (
    "id" TEXT NOT NULL,
    "packet_id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "tng_name" TEXT NOT NULL,
    "tng_name_hash" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL,
    "device_id" TEXT,
    "status" "TngClaimInboxStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "claim_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tng_claim_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tng_claim_inbox_packet_id_tng_name_hash_amount_cents_key" ON "tng_claim_inbox"("packet_id", "tng_name_hash", "amount_cents");

-- CreateIndex
CREATE INDEX "tng_claim_inbox_status_created_at_idx" ON "tng_claim_inbox"("status", "created_at");

-- AddForeignKey
ALTER TABLE "tng_claim_inbox" ADD CONSTRAINT "tng_claim_inbox_packet_id_fkey" FOREIGN KEY ("packet_id") REFERENCES "packets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

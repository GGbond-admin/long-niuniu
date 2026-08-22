-- AlterTable
ALTER TABLE "packets" ADD COLUMN "scheduler_packet_id" TEXT;
ALTER TABLE "packets" ADD COLUMN "scheduler_after_seq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "packets" ADD COLUMN "scheduler_claims_final" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "packets" ADD COLUMN "scheduler_last_error" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "packets_scheduler_packet_id_key" ON "packets"("scheduler_packet_id");

-- CreateTable
CREATE TABLE "group_packets" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "total_cents" BIGINT NOT NULL,
    "count" INTEGER NOT NULL,
    "remaining_cents" BIGINT NOT NULL,
    "remaining_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_packets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_packet_claims" (
    "id" TEXT NOT NULL,
    "packet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_packet_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_packets_room_id_created_at_idx" ON "group_packets"("room_id", "created_at");

-- CreateIndex
CREATE INDEX "group_packets_status_expires_at_idx" ON "group_packets"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "group_packet_claims_packet_id_user_id_key" ON "group_packet_claims"("packet_id", "user_id");

-- AddForeignKey
ALTER TABLE "group_packets" ADD CONSTRAINT "group_packets_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_packet_claims" ADD CONSTRAINT "group_packet_claims_packet_id_fkey" FOREIGN KEY ("packet_id") REFERENCES "group_packets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_packet_claims" ADD CONSTRAINT "group_packet_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

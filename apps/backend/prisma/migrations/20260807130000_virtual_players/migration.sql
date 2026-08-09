-- AlterTable: User.tgId nullable + User.kind
CREATE TYPE "UserKind" AS ENUM ('HUMAN', 'VIRTUAL');

ALTER TABLE "users" ALTER COLUMN "tg_id" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "kind" "UserKind" NOT NULL DEFAULT 'HUMAN';
CREATE INDEX "users_kind_idx" ON "users"("kind");

-- CreateTable
CREATE TABLE "virtual_players" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "can_join" BOOLEAN NOT NULL DEFAULT true,
    "can_chat" BOOLEAN NOT NULL DEFAULT true,
    "can_bid" BOOLEAN NOT NULL DEFAULT true,
    "can_bet" BOOLEAN NOT NULL DEFAULT true,
    "can_all_in" BOOLEAN NOT NULL DEFAULT false,
    "can_banker" BOOLEAN NOT NULL DEFAULT true,
    "can_continue" BOOLEAN NOT NULL DEFAULT false,
    "can_throw_dice" BOOLEAN NOT NULL DEFAULT true,
    "can_group_packet" BOOLEAN NOT NULL DEFAULT false,
    "can_claim_sim" BOOLEAN NOT NULL DEFAULT true,
    "bid_weight" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "bet_ratio_min" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "bet_ratio_max" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "chat_phrases" JSONB,
    "target_balance_cents" BIGINT NOT NULL DEFAULT 500000,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_players_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "virtual_players_user_id_key" ON "virtual_players"("user_id");
CREATE INDEX "virtual_players_room_id_enabled_idx" ON "virtual_players"("room_id", "enabled");

ALTER TABLE "virtual_players" ADD CONSTRAINT "virtual_players_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "virtual_players" ADD CONSTRAINT "virtual_players_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

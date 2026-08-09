-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BANNED');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'UNBOUND');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('USER_AVAILABLE', 'USER_FREEZE_BANKER', 'USER_FREEZE_BET', 'PLATFORM_RAKE', 'PLATFORM_FEES', 'PLATFORM_RESERVE', 'TNG_TRANSIT', 'PLATFORM_REWARD', 'PLATFORM_REBATE', 'ADJUST_CLEARING');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'LEFT', 'BANNED');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "RoundPhase" AS ENUM ('WAITING', 'BANKER_BID', 'BETTING', 'SENDING_PACKET', 'CLAIMING', 'SETTLING', 'FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('FROZEN', 'WITHDRAWN', 'SETTLED', 'REFUNDED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "PacketStatus" AS ENUM ('CREATED', 'SENT', 'EXPIRED', 'CANCELLED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "ClaimSource" AS ENUM ('MANUAL', 'PROVIDER');

-- CreateEnum
CREATE TYPE "SettleOutcome" AS ENUM ('PLAYER_WIN', 'BANKER_WIN', 'TIE', 'VOID');

-- CreateEnum
CREATE TYPE "RewardTab" AS ENUM ('CHESS', 'BANKER', 'SPECIAL');

-- CreateEnum
CREATE TYPE "ChatSender" AS ENUM ('USER', 'SUPPORT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'EMOJI', 'STICKER', 'IMAGE');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER', 'OPERATOR', 'REVIEWER', 'FINANCE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tg_id" BIGINT NOT NULL,
    "uid" TEXT NOT NULL,
    "nickname" TEXT,
    "tg_username" TEXT,
    "avatar_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_bot_id" TEXT,
    "inviter_id" TEXT,
    "grand_inviter_id" TEXT,
    "inviter_bound_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "bound_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "real_name" TEXT NOT NULL,
    "real_name_hash" TEXT,
    "duitnow_id" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "bank_account" TEXT NOT NULL,
    "account_holder" TEXT NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "reject_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "available_cents" BIGINT NOT NULL DEFAULT 0,
    "freeze_banker_cents" BIGINT NOT NULL DEFAULT 0,
    "freeze_bet_cents" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_accounts" (
    "id" TEXT NOT NULL,
    "account_type" "AccountType" NOT NULL,
    "balance_cents" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_ledger" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "account_type" "AccountType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "balance_after_cents" BIGINT,
    "round_id" TEXT,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "operator_id" TEXT,
    "memo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "proof_url" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdraw_orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "channel" TEXT NOT NULL,
    "target_snapshot" JSONB NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdraw_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_bots" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "BotStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "min_players" INTEGER NOT NULL DEFAULT 2,
    "status" "RoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "invite_link" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_members" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rounds" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "seq_no" INTEGER NOT NULL,
    "phase" "RoundPhase" NOT NULL DEFAULT 'WAITING',
    "banker_id" TEXT,
    "pot_cents" BIGINT NOT NULL DEFAULT 0,
    "banker_reserved_cents" BIGINT NOT NULL DEFAULT 0,
    "is_continued" BOOLEAN NOT NULL DEFAULT false,
    "continuation_used" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "config_snapshot" JSONB,
    "bid_ends_at" TIMESTAMP(3),
    "bet_ends_at" TIMESTAMP(3),
    "claim_ends_at" TIMESTAMP(3),
    "status_message_id" BIGINT,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banker_bids" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "won" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banker_bids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "is_all_in" BOOLEAN NOT NULL DEFAULT false,
    "status" "BetStatus" NOT NULL DEFAULT 'FROZEN',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_events" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "round_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packets" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "packer_account" TEXT,
    "claim_url" TEXT,
    "total_cents" BIGINT NOT NULL,
    "participant_count" INTEGER NOT NULL,
    "status" "PacketStatus" NOT NULL DEFAULT 'CREATED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "reconciled_cents" BIGINT NOT NULL DEFAULT 0,
    "returned_cents" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "packets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "packet_id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "tng_name" TEXT,
    "hand_type" TEXT,
    "points" INTEGER,
    "source" "ClaimSource" NOT NULL DEFAULT 'MANUAL',
    "entered_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tng_accounts" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "masked_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "monthly_limit_cents" BIGINT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tng_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "bet_cents" BIGINT NOT NULL,
    "banker_amount_cents" BIGINT NOT NULL,
    "player_amount_cents" BIGINT NOT NULL,
    "banker_hand" TEXT NOT NULL,
    "player_hand" TEXT NOT NULL,
    "banker_points" INTEGER NOT NULL,
    "player_points" INTEGER NOT NULL,
    "outcome" "SettleOutcome" NOT NULL,
    "is_bust_player" BOOLEAN NOT NULL DEFAULT false,
    "is_bust_banker" BOOLEAN NOT NULL DEFAULT false,
    "multiplier" INTEGER NOT NULL DEFAULT 1,
    "payable_cents" BIGINT NOT NULL DEFAULT 0,
    "paid_cents" BIGINT NOT NULL DEFAULT 0,
    "shortfall_cents" BIGINT NOT NULL DEFAULT 0,
    "rake_cents" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_scoreboards" (
    "id" TEXT NOT NULL,
    "round_id" TEXT NOT NULL,
    "seq_no" INTEGER NOT NULL,
    "player_lines" JSONB NOT NULL,
    "banker_summary" JSONB NOT NULL,
    "published_message_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "round_scoreboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banker_stats" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "total_profit_cents" BIGINT NOT NULL DEFAULT 0,
    "rounds_as_banker" INTEGER NOT NULL DEFAULT 0,
    "rounds_today" INTEGER NOT NULL DEFAULT 0,
    "today_date" TEXT,
    "trend_recent" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "banker_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_configs" (
    "id" TEXT NOT NULL,
    "tab" "RewardTab" NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "daily_quota" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_grants" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "ledger_ref" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_hand_progress" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_hand_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turnover_daily" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "self_cents" BIGINT NOT NULL DEFAULT 0,
    "l1_cents" BIGINT NOT NULL DEFAULT 0,
    "l2_cents" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "turnover_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rebate_settlements" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "self_cents" BIGINT NOT NULL,
    "l1_cents" BIGINT NOT NULL,
    "l2_cents" BIGINT NOT NULL,
    "rates_snapshot" JSONB NOT NULL,
    "commission_cents" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PAID',
    "ledger_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rebate_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboards" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "rank_snapshot" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "image_url" TEXT,
    "target" TEXT NOT NULL DEFAULT 'ALL',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "sender_type" "ChatSender" NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT,
    "asset_url" TEXT,
    "operator_id" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sticker_assets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sticker_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_templates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_jobs" (
    "id" TEXT NOT NULL,
    "template_id" TEXT,
    "bot_id" TEXT,
    "audience" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_logs" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "message_id" BIGINT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'OPERATOR',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_configs" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_tg_id_key" ON "users"("tg_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_uid_key" ON "users"("uid");

-- CreateIndex
CREATE INDEX "users_inviter_id_idx" ON "users"("inviter_id");

-- CreateIndex
CREATE INDEX "users_grand_inviter_id_idx" ON "users"("grand_inviter_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_key" ON "devices"("user_id");

-- CreateIndex
CREATE INDEX "devices_device_id_idx" ON "devices"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_user_id_key" ON "kyc"("user_id");

-- CreateIndex
CREATE INDEX "kyc_status_idx" ON "kyc"("status");

-- CreateIndex
CREATE INDEX "kyc_real_name_hash_idx" ON "kyc"("real_name_hash");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_user_id_key" ON "wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_accounts_account_type_key" ON "platform_accounts"("account_type");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_ledger_idempotency_key_key" ON "wallet_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_ledger_user_id_created_at_idx" ON "wallet_ledger"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_ledger_round_id_idx" ON "wallet_ledger"("round_id");

-- CreateIndex
CREATE INDEX "deposit_orders_status_idx" ON "deposit_orders"("status");

-- CreateIndex
CREATE INDEX "withdraw_orders_status_idx" ON "withdraw_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_bots_username_key" ON "telegram_bots"("username");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_chat_id_key" ON "rooms"("chat_id");

-- CreateIndex
CREATE INDEX "room_members_room_id_status_idx" ON "room_members"("room_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "room_members_room_id_user_id_key" ON "room_members"("room_id", "user_id");

-- CreateIndex
CREATE INDEX "rounds_phase_idx" ON "rounds"("phase");

-- CreateIndex
CREATE UNIQUE INDEX "rounds_room_id_seq_no_key" ON "rounds"("room_id", "seq_no");

-- CreateIndex
CREATE UNIQUE INDEX "banker_bids_round_id_user_id_key" ON "banker_bids"("round_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "bets_round_id_user_id_key" ON "bets"("round_id", "user_id");

-- CreateIndex
CREATE INDEX "round_events_round_id_created_at_idx" ON "round_events"("round_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "packets_round_id_key" ON "packets"("round_id");

-- CreateIndex
CREATE UNIQUE INDEX "claims_round_id_user_id_key" ON "claims"("round_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_round_id_user_id_key" ON "settlements"("round_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_scoreboards_round_id_key" ON "round_scoreboards"("round_id");

-- CreateIndex
CREATE UNIQUE INDEX "banker_stats_user_id_room_id_key" ON "banker_stats"("user_id", "room_id");

-- CreateIndex
CREATE UNIQUE INDEX "reward_configs_code_key" ON "reward_configs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "reward_grants_config_id_user_id_date_key" ON "reward_grants"("config_id", "user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_hand_progress_user_id_date_key" ON "daily_hand_progress"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "turnover_daily_user_id_date_key" ON "turnover_daily"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "rebate_settlements_user_id_date_key" ON "rebate_settlements"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboards_type_period_period_key_key" ON "leaderboards"("type", "period", "period_key");

-- CreateIndex
CREATE INDEX "announcements_status_scheduled_at_idx" ON "announcements"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "chat_messages_user_id_created_at_idx" ON "chat_messages"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_templates_code_key" ON "push_templates"("code");

-- CreateIndex
CREATE INDEX "push_logs_job_id_idx" ON "push_logs"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");

-- CreateIndex
CREATE INDEX "audit_logs_admin_id_created_at_idx" ON "audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "game_configs_key_key" ON "game_configs"("key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc" ADD CONSTRAINT "kyc_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_orders" ADD CONSTRAINT "deposit_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdraw_orders" ADD CONSTRAINT "withdraw_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "telegram_bots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banker_bids" ADD CONSTRAINT "banker_bids_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banker_bids" ADD CONSTRAINT "banker_bids_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_events" ADD CONSTRAINT "round_events_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packets" ADD CONSTRAINT "packets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_packet_id_fkey" FOREIGN KEY ("packet_id") REFERENCES "packets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_scoreboards" ADD CONSTRAINT "round_scoreboards_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banker_stats" ADD CONSTRAINT "banker_stats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_grants" ADD CONSTRAINT "reward_grants_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "reward_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_grants" ADD CONSTRAINT "reward_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebate_settlements" ADD CONSTRAINT "rebate_settlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_jobs" ADD CONSTRAINT "push_jobs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "push_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_logs" ADD CONSTRAINT "push_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "push_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

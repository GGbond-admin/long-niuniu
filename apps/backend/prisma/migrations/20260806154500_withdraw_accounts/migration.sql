-- CreateEnum
CREATE TYPE "WithdrawAccountType" AS ENUM ('BANK', 'EWALLET');

-- CreateEnum
CREATE TYPE "WithdrawAccountStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "withdraw_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "WithdrawAccountType" NOT NULL,
    "institution" TEXT NOT NULL,
    "account_no" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "WithdrawAccountStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'user',
    "reject_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdraw_accounts_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "withdraw_orders" ADD COLUMN "withdraw_account_id" TEXT;

-- CreateIndex
CREATE INDEX "withdraw_accounts_user_id_status_idx" ON "withdraw_accounts"("user_id", "status");

-- CreateIndex
CREATE INDEX "withdraw_accounts_status_idx" ON "withdraw_accounts"("status");

-- AddForeignKey
ALTER TABLE "withdraw_accounts" ADD CONSTRAINT "withdraw_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdraw_orders" ADD CONSTRAINT "withdraw_orders_withdraw_account_id_fkey" FOREIGN KEY ("withdraw_account_id") REFERENCES "withdraw_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

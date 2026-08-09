-- CreateEnum
CREATE TYPE "DepositPayeeStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "deposit_payee_accounts" (
    "id" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_no" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "label" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "status" "DepositPayeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_payee_accounts_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "deposit_orders" ADD COLUMN "payee_account_id" TEXT;
ALTER TABLE "deposit_orders" ADD COLUMN "payee_snapshot" JSONB;

-- CreateIndex
CREATE INDEX "deposit_payee_accounts_status_is_current_idx" ON "deposit_payee_accounts"("status", "is_current");

-- AddForeignKey
ALTER TABLE "deposit_orders" ADD CONSTRAINT "deposit_orders_payee_account_id_fkey" FOREIGN KEY ("payee_account_id") REFERENCES "deposit_payee_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

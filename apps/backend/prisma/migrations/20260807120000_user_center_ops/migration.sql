-- AlterTable: admin notes on users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "admin_note" TEXT;

-- AlterTable: searchable KYC blind indexes
ALTER TABLE "kyc" ADD COLUMN IF NOT EXISTS "duitnow_hash" TEXT;
ALTER TABLE "kyc" ADD COLUMN IF NOT EXISTS "bank_account_hash" TEXT;
ALTER TABLE "kyc" ADD COLUMN IF NOT EXISTS "bank_account_last4_hash" TEXT;

CREATE INDEX IF NOT EXISTS "kyc_duitnow_hash_idx" ON "kyc"("duitnow_hash");
CREATE INDEX IF NOT EXISTS "kyc_bank_account_hash_idx" ON "kyc"("bank_account_hash");
CREATE INDEX IF NOT EXISTS "kyc_bank_account_last4_hash_idx" ON "kyc"("bank_account_last4_hash");

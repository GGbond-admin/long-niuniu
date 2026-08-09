-- CreateEnum
CREATE TYPE "UsdtStatus" AS ENUM ('NONE', 'PENDING', 'VERIFIED', 'REJECTED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "usdt_address" TEXT;
ALTER TABLE "users" ADD COLUMN "usdt_network" TEXT;
ALTER TABLE "users" ADD COLUMN "usdt_status" "UsdtStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "users" ADD COLUMN "usdt_note" TEXT;
ALTER TABLE "users" ADD COLUMN "usdt_updated_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "usdt_updated_by" TEXT;

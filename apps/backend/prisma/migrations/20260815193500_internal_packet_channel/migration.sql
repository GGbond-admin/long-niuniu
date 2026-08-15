-- CreateEnum
CREATE TYPE "PacketChannel" AS ENUM ('TNG', 'INTERNAL');

-- AlterEnum
ALTER TYPE "ClaimSource" ADD VALUE 'INTERNAL';

-- AlterTable
ALTER TABLE "packets" ADD COLUMN "channel" "PacketChannel" NOT NULL DEFAULT 'TNG';

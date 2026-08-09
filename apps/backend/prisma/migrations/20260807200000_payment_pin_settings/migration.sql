ALTER TABLE "devices"
ADD COLUMN "auth_version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "payment_pins" (
  "user_id" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "failed_attempts" INTEGER NOT NULL DEFAULT 0,
  "locked_until" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "payment_pins_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "payment_pins"
ADD CONSTRAINT "payment_pins_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "group_packets"
ADD COLUMN "request_id" TEXT;

UPDATE "group_packets"
SET "request_id" = "id"
WHERE "request_id" IS NULL;

ALTER TABLE "group_packets"
ALTER COLUMN "request_id" SET NOT NULL;

CREATE UNIQUE INDEX "group_packets_sender_id_request_id_key"
ON "group_packets"("sender_id", "request_id");

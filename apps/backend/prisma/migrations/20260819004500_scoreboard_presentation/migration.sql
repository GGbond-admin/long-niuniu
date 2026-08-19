CREATE TYPE "ScoreboardSyncStatus" AS ENUM (
  'LEGACY',
  'PENDING',
  'SYNCED',
  'FAILED',
  'MESSAGE_EXPIRED'
);

ALTER TABLE "round_scoreboards"
  ADD COLUMN "presentation" JSONB,
  ADD COLUMN "presentation_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "presentation_updated_by" TEXT,
  ADD COLUMN "presentation_sync_status" "ScoreboardSyncStatus" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "presentation_sync_error" TEXT,
  ADD COLUMN "presentation_synced_at" TIMESTAMP(3),
  ADD COLUMN "published_chat_message_ids" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "round_scoreboard_revisions" (
  "id" TEXT NOT NULL,
  "scoreboard_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "presentation" JSONB NOT NULL,
  "rendered_chunks" JSONB NOT NULL DEFAULT '[]',
  "reason" TEXT NOT NULL,
  "admin_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "round_scoreboard_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "round_scoreboard_revisions_scoreboard_id_fkey"
    FOREIGN KEY ("scoreboard_id") REFERENCES "round_scoreboards"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "round_scoreboard_revisions_scoreboard_id_revision_key"
  ON "round_scoreboard_revisions"("scoreboard_id", "revision");

CREATE INDEX "round_scoreboard_revisions_admin_id_created_at_idx"
  ON "round_scoreboard_revisions"("admin_id", "created_at");

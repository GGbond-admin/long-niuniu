-- CreateTable
CREATE TABLE "system_notices" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "audience_uids" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "push_telegram" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_notice_reads" (
    "id" TEXT NOT NULL,
    "notice_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_notice_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_notices_status_published_at_idx" ON "system_notices"("status", "published_at");

-- CreateIndex
CREATE INDEX "system_notice_reads_user_id_read_at_idx" ON "system_notice_reads"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "system_notice_reads_notice_id_user_id_key" ON "system_notice_reads"("notice_id", "user_id");

-- AddForeignKey
ALTER TABLE "system_notice_reads" ADD CONSTRAINT "system_notice_reads_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "system_notices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_notice_reads" ADD CONSTRAINT "system_notice_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

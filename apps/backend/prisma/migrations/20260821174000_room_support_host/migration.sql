-- 互动群客服小妹绑定真人账号，打赏后由该账号自动致谢。
ALTER TABLE "rooms"
  ADD COLUMN "support_host_user_id" TEXT;

ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_support_host_user_id_fkey"
  FOREIGN KEY ("support_host_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "rooms_support_host_user_id_idx"
  ON "rooms"("support_host_user_id");

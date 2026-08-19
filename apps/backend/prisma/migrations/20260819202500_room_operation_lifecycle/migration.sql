-- 互动群运行模式：手动单局、自动连续、结束待机。
CREATE TYPE "RoomStartMode" AS ENUM ('MANUAL', 'AUTO', 'STOPPED');

ALTER TABLE "rooms"
  ADD COLUMN "round_start_mode" "RoomStartMode" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "chat_muted_at" TIMESTAMP(3),
  ADD COLUMN "chat_mute_reason" TEXT,
  ADD COLUMN "chat_muted_by_admin_id" TEXT;

-- 保留升级前已开启自动开局的房间，避免部署后意外停局。
UPDATE "rooms" AS room
SET "round_start_mode" = 'AUTO'::"RoomStartMode"
FROM "game_configs" AS config
WHERE config."game_code" = room."game_code"
  AND config."key" = 'round'
  AND COALESCE(config."value"->>'autoStart', 'false') = 'true';

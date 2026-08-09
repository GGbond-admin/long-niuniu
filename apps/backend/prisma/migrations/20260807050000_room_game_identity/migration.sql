-- 一款游戏只能对应一个互动群。现有最早房间归属至尊牛牛；
-- 其余历史房间保留账务/局记录但暂停并标为不受支持，避免数据删除。
ALTER TABLE "rooms" ADD COLUMN "game_code" TEXT;

WITH ranked_rooms AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (ORDER BY "created_at" ASC, "id" ASC) AS room_rank
  FROM "rooms"
)
UPDATE "rooms" AS room
SET
  "game_code" = CASE
    WHEN ranked.room_rank = 1 THEN 'SUPREME_NIUNIU'
    ELSE 'LEGACY_' || ranked.room_rank::TEXT || '_' || room."id"
  END,
  "title" = CASE
    WHEN ranked.room_rank = 1 THEN '至尊牛牛'
    ELSE room."title"
  END,
  "status" = CASE
    WHEN ranked.room_rank = 1 THEN room."status"
    ELSE 'PAUSED'::"RoomStatus"
  END
FROM ranked_rooms AS ranked
WHERE room."id" = ranked."id";

ALTER TABLE "rooms"
  ALTER COLUMN "game_code" SET NOT NULL,
  ALTER COLUMN "game_code" SET DEFAULT 'SUPREME_NIUNIU';

CREATE UNIQUE INDEX "rooms_game_code_key" ON "rooms"("game_code");

-- 取消局不占用有效局号：同一房间允许「已取消的 18 局」与「重新开出的 18 局」并存。
-- 有效局（非 CANCELLED）的 (room_id, seq_no) 仍唯一。
DROP INDEX IF EXISTS "rounds_room_id_seq_no_key";

CREATE UNIQUE INDEX "rounds_room_id_seq_no_valid_key"
  ON "rounds" ("room_id", "seq_no")
  WHERE "phase" <> 'CANCELLED';

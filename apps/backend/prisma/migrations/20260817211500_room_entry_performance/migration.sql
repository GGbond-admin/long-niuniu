-- 进互动群热路径：当前牌局按房间/阶段读取，并统计玩家近 24 小时参与局数。
CREATE INDEX "rounds_room_id_phase_seq_no_idx"
  ON "rounds"("room_id", "phase", "seq_no");

CREATE INDEX "claims_user_id_created_at_idx"
  ON "claims"("user_id", "created_at");

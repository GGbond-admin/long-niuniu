-- 按房间与庄家回溯已结算局，重建该庄家独立走势。
-- Prisma 的 PostgreSQL 迁移默认不包事务；并发建索引避免历史局较多时阻塞牌局写入。
CREATE INDEX CONCURRENTLY "rounds_room_id_banker_id_phase_seq_no_idx"
  ON "rounds"("room_id", "banker_id", "phase", "seq_no");

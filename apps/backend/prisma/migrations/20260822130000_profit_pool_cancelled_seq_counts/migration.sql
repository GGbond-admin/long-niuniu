-- 取消局不占号后，利润池只结算已完成有效局。
-- round_count 不再等于「结束局号 − 开始局号 + 1」，取消局也不再计入 round_count。
-- 局号区间排他约束会把区间内的取消号也锁死，导致复用后的有效局无法再生成利润池。

ALTER TABLE "profit_pool_batches"
  DROP CONSTRAINT IF EXISTS "profit_pool_batches_round_count_check";

ALTER TABLE "profit_pool_batches"
  DROP CONSTRAINT IF EXISTS "profit_pool_batches_terminal_counts_check";

ALTER TABLE "profit_pool_batches"
  ADD CONSTRAINT "profit_pool_batches_terminal_counts_check"
  CHECK (
    "finished_round_count" >= 0
    AND "cancelled_round_count" >= 0
    AND "round_count" > 0
  );

ALTER TABLE "profit_pool_batches"
  DROP CONSTRAINT IF EXISTS "profit_pool_batches_room_seq_range_excl";

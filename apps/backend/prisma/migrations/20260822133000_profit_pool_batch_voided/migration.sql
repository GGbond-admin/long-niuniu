-- 未发放的利润池可撤回：新增 VOIDED，并记录操作人。局锁在撤回时删除。

ALTER TYPE "ProfitPoolBatchStatus" ADD VALUE 'VOIDED';

ALTER TABLE "profit_pool_batches"
  ADD COLUMN IF NOT EXISTS "discarded_by" TEXT,
  ADD COLUMN IF NOT EXISTS "discarded_at" TIMESTAMP(3);

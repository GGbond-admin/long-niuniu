import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260819030000_profit_pool_round_batches/migration.sql',
  import.meta.url,
);

describe('profit pool cutover migration contract', () => {
  it('fails before installing the cutover when legacy pending reports exist', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const transactionStart = sql.indexOf('BEGIN;');
    const writeLock = sql.indexOf(
      'LOCK TABLE "profit_pool_daily", "agent_profit_shares"',
    );
    const preflight = sql.indexOf("WHERE \"status\" = 'PENDING'");
    const firstNewTable = sql.indexOf('CREATE TABLE "profit_pool_batches"');
    const triggerInstall = sql.indexOf(
      'CREATE TRIGGER "profit_pool_daily_write_block_after_cutover"',
    );
    const transactionCommit = sql.lastIndexOf('COMMIT;');

    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(writeLock).toBeGreaterThan(transactionStart);
    expect(writeLock).toBeLessThan(preflight);
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(firstNewTable);
    expect(transactionCommit).toBeGreaterThan(triggerInstall);
    expect(sql).toContain('legacy pending profit pools must be resolved before cutover');
  });

  it('derives covered round cutoffs from legacy-covered settlements', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    const cutoverStart = sql.indexOf('WITH "finalized_legacy_days"');
    const triggerStart = sql.indexOf(
      'CREATE FUNCTION "reject_legacy_profit_pool_write"',
    );
    const cutoverSql = sql.slice(cutoverStart, triggerStart);

    expect(cutoverSql).toContain('JOIN "settlements"');
    expect(cutoverSql).toContain('s."created_at"');
    expect(cutoverSql).toContain('r."settled_at"');
    expect(cutoverSql).not.toContain('r."finished_at" <');
  });
});

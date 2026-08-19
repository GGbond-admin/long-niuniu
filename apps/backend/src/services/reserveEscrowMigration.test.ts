import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260819183500_reserve_escrow_reconciliation/migration.sql',
  import.meta.url,
);

describe('红包备付金修复迁移', () => {
  it('按活跃群红包未领金额补足备付金并保留双边调账流水', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('SUM("remaining_cents")');
    expect(sql).toContain(`WHERE "status" = 'ACTIVE'`);
    expect(sql).toContain(
      'adjustment := GREATEST(group_packet_obligations - reserve_before, 0)',
    );
    expect(sql).toContain(`'ADJUST_CLEARING'`);
    expect(sql).toContain(`'PLATFORM_RESERVE'`);
    expect(sql).toContain(`'reserve_reconciliation'`);
    expect(sql).toContain('reserve-reconciliation:20260819183500:out');
    expect(sql).toContain('reserve-reconciliation:20260819183500:in');
  });

  it('修复旧余额后启用并验证备付金非负约束', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql).toContain('platform_accounts_reserve_nonnegative');
    expect(sql).toContain(`"account_type" <> 'PLATFORM_RESERVE'`);
    expect(sql).toContain('OR "balance_cents" >= 0');
    expect(sql).toContain(
      'VALIDATE CONSTRAINT "platform_accounts_reserve_nonnegative"',
    );
  });
});

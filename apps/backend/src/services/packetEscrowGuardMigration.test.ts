import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260819191500_packet_escrow_cutover_guard/migration.sql',
  import.meta.url,
);

describe('红包托管切换数据库守卫', () => {
  it('在同一事务内安装旧实例写入守卫并再次校准备付金', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain('enforce_packet_escrow_before_reserve_debit');
    expect(sql).toContain(`'packet_internal_claim'`);
    expect(sql).toContain(`'packet_create'`);
    expect(sql).toContain(`settle:fee_packet_agent:`);
    expect(sql).toContain('SUM("remaining_cents")');
    expect(sql).toContain(
      'adjustment := GREATEST(group_packet_obligations - reserve_before, 0)',
    );
  });
});

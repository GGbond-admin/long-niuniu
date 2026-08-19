import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260819192500_internal_packet_reserve_obligations/migration.sql',
  import.meta.url,
);

describe('红包备付金完整义务校准', () => {
  it('原子计入群红包及已预付站内红包的全部未领金额', async () => {
    const sql = await readFile(migrationUrl, 'utf8');

    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain('LOCK TABLE "wallet_ledger"');
    expect(sql).toContain('group_packet_obligations');
    expect(sql).toContain('internal_packet_obligations');
    expect(sql).toContain(`packet."status" IN ('SENT', 'EXPIRED')`);
    expect(sql).toContain(`settle:fee_packet_agent:`);
    expect(sql).toContain(
      'required_balance := group_packet_obligations + internal_packet_obligations',
    );
  });
});

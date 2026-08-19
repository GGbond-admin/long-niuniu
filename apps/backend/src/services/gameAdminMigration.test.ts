import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../prisma/migrations/20260819170000_game_admin_management/migration.sql',
  import.meta.url,
);

describe('game administrator migration contract', () => {
  it('enforces one assignment and one budget account per game identity', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(
      'game_admin_assignments_game_code_user_id_key',
    );
    expect(sql).toContain(
      'ON "game_admin_assignments"("game_code", "user_id")',
    );
    expect(sql).toContain('game_budget_accounts_game_code_key');
    expect(sql).toContain('ON "game_budget_accounts"("game_code")');
  });

  it('prevents negative balances and non-positive immutable ledger entries', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('"game_budget_accounts_balance_nonnegative"');
    expect(sql).toContain('CHECK ("balance_cents" >= 0)');
    expect(sql).toContain('"game_budget_ledger_amount_positive"');
    expect(sql).toContain('CHECK ("amount_cents" > 0)');
    expect(sql).toContain('"game_budget_ledger_balance_nonnegative"');
    expect(sql).toContain('CHECK ("balance_after_cents" >= 0)');
    expect(sql).toContain('game_budget_ledger_idempotency_key_key');
  });

  it('backfills legacy packets as personal-wallet packets and requires both budget references', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(
      `"funding_source" "GroupPacketFundingSource" NOT NULL DEFAULT 'USER_WALLET'`,
    );
    expect(sql).toContain('"funding_source" = \'USER_WALLET\'');
    expect(sql).toContain('"budget_account_id" IS NULL');
    expect(sql).toContain('"funding_source" = \'GAME_BUDGET\'');
    expect(sql).toContain('"budget_account_id" IS NOT NULL');
    expect(sql).toContain('"game_admin_assignment_id" IS NOT NULL');
  });
});

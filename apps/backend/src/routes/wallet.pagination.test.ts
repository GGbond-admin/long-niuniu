import { describe, expect, it } from 'vitest';
import { paginateWalletEntries } from './wallet.js';

describe('钱包流水分页', () => {
  it('下一页游标指向本页最后一条，不跳过未返回记录', () => {
    const rows = Array.from({ length: 31 }, (_, index) => ({ id: `entry-${index + 1}` }));

    const result = paginateWalletEntries(rows, 30);

    expect(result.page).toHaveLength(30);
    expect(result.page.at(-1)?.id).toBe('entry-30');
    expect(result.nextCursor).toBe('entry-30');
    expect(rows.findIndex((row) => row.id === result.nextCursor) + 1).toBe(30);
  });

  it('没有更多记录时不返回游标', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: `entry-${index + 1}` }));

    const result = paginateWalletEntries(rows, 30);

    expect(result.page).toEqual(rows);
    expect(result.nextCursor).toBeNull();
  });
});

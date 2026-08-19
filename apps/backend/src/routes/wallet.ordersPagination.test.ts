import { describe, expect, it } from 'vitest';
import {
  decodeWalletOrderCursor,
  paginateWalletOrders,
  walletOrderIsAfterCursor,
  type WalletOrderCursor,
  type WalletOrderRef,
} from './wallet.js';

function sourceOrder(a: WalletOrderRef, b: WalletOrderRef) {
  const byDate = b.createdAt.getTime() - a.createdAt.getTime();
  return byDate || b.id.localeCompare(a.id);
}

function loadPage(
  deposits: WalletOrderRef[],
  withdrawals: WalletOrderRef[],
  limit: number,
  cursor: WalletOrderCursor | null,
) {
  const candidates = [
    ...deposits
      .filter((item) => !cursor || walletOrderIsAfterCursor(item, cursor))
      .sort(sourceOrder)
      .slice(0, limit + 1),
    ...withdrawals
      .filter((item) => !cursor || walletOrderIsAfterCursor(item, cursor))
      .sort(sourceOrder)
      .slice(0, limit + 1),
  ];
  return paginateWalletOrders(candidates, limit);
}

describe('充提工单全局分页', () => {
  it('不会让旧提现排在仍未加载的新充值前面', () => {
    const origin = Date.parse('2026-08-19T03:00:00.000Z');
    const deposits = Array.from({ length: 60 }, (_, index) => ({
      id: `deposit-${String(index).padStart(2, '0')}`,
      kind: 'deposit' as const,
      createdAt: new Date(origin - index * 60_000),
    }));
    const withdrawals = [
      {
        id: 'withdrawal-old',
        kind: 'withdrawal' as const,
        createdAt: new Date(origin - 120 * 60_000),
      },
    ];

    const first = loadPage(deposits, withdrawals, 50, null);
    const second = loadPage(
      deposits,
      withdrawals,
      50,
      decodeWalletOrderCursor(first.nextCursor!),
    );

    expect(first.page).toHaveLength(50);
    expect(first.page.every((item) => item.kind === 'deposit')).toBe(true);
    expect(second.page.map((item) => item.id)).toEqual([
      ...deposits.slice(50).map((item) => item.id),
      'withdrawal-old',
    ]);
    expect([
      ...new Set([...first.page, ...second.page].map((item) => item.id)),
    ]).toHaveLength(61);
  });

  it('同毫秒跨类型翻页时保持稳定且不重不漏', () => {
    const createdAt = new Date('2026-08-19T03:00:00.000Z');
    const deposits = ['deposit-b', 'deposit-a'].map((id) => ({
      id,
      kind: 'deposit' as const,
      createdAt,
    }));
    const withdrawals = ['withdrawal-b', 'withdrawal-a'].map((id) => ({
      id,
      kind: 'withdrawal' as const,
      createdAt,
    }));

    const first = loadPage(deposits, withdrawals, 3, null);
    const second = loadPage(
      deposits,
      withdrawals,
      3,
      decodeWalletOrderCursor(first.nextCursor!),
    );

    expect(first.page.map((item) => item.id)).toEqual([
      'deposit-b',
      'deposit-a',
      'withdrawal-b',
    ]);
    expect(second.page.map((item) => item.id)).toEqual(['withdrawal-a']);
  });
});

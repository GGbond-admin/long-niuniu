import { AccountType, type OrderStatus, type Prisma } from '@prisma/client';
import { formatRatioPercent, rakeRatioFor } from '../engine/fees.js';
import { prisma } from '../lib/prisma.js';
import { safeDecryptSecret } from '../lib/crypto.js';
import { SUPREME_NIUNIU_GAME_CODE } from './gameCatalog.js';
import { getGameSettings } from './gameSettings.js';
import { malaysiaDay } from './rebates.js';

export const FINANCE_TREND_MAX_DAYS = 90;

type DayBucket = {
  date: string;
  rakeCents: bigint;
  seatFeeCents: bigint;
  serviceFeeCents: bigint;
  rewardsCents: bigint;
  rebatesCents: bigint;
  profitShareCents: bigint;
  depositsCents: bigint;
  withdrawalsCents: bigint;
};

function emptyDay(date: string): DayBucket {
  return {
    date,
    rakeCents: 0n,
    seatFeeCents: 0n,
    serviceFeeCents: 0n,
    rewardsCents: 0n,
    rebatesCents: 0n,
    profitShareCents: 0n,
    depositsCents: 0n,
    withdrawalsCents: 0n,
  };
}

export function enumerateKlDays(days: number, today = malaysiaDay()): string[] {
  const count = Math.max(1, Math.min(FINANCE_TREND_MAX_DAYS, Math.trunc(days)));
  const end = new Date(`${today}T00:00:00+08:00`);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(end.getTime() - (count - 1 - index) * 86_400_000);
    return malaysiaDay(day);
  });
}

export function enumerateKlRange(from: string, to: string): string[] {
  const startKey = from <= to ? from : to;
  const endKey = from <= to ? to : from;
  const start = new Date(`${startKey}T00:00:00+08:00`);
  const end = new Date(`${endKey}T00:00:00+08:00`);
  const span = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const count = Math.max(1, Math.min(FINANCE_TREND_MAX_DAYS, span));
  return Array.from({ length: count }, (_, index) =>
    malaysiaDay(new Date(start.getTime() + index * 86_400_000)),
  );
}

export function resolveFinanceTrendDates(
  input: { days?: number; from?: string; to?: string },
  today = malaysiaDay(),
) {
  if (input.from && input.to) return enumerateKlRange(input.from, input.to);
  return enumerateKlDays(input.days ?? 7, today);
}

export function applyFinanceTrendRow(
  bucket: DayBucket,
  row: {
    accountType: AccountType | string;
    direction: 'CREDIT' | 'DEBIT' | string;
    refType: string;
    amountCents: bigint;
  },
) {
  const amount = row.amountCents;
  if (row.accountType === AccountType.PLATFORM_RAKE && row.direction === 'CREDIT') {
    bucket.rakeCents += amount;
    return;
  }
  if (row.accountType === AccountType.PLATFORM_FEES && row.direction === 'CREDIT') {
    if (row.refType === 'fee_banker_seat') bucket.seatFeeCents += amount;
    else if (row.refType === 'fee_service') bucket.serviceFeeCents += amount;
    return;
  }
  if (row.accountType === AccountType.PLATFORM_REWARD && row.direction === 'DEBIT') {
    bucket.rewardsCents += amount;
    return;
  }
  if (row.accountType === AccountType.PLATFORM_REBATE) {
    if (row.direction === 'DEBIT') bucket.rebatesCents += amount;
    if (row.direction === 'CREDIT' && row.refType === 'rebate_revoke') {
      bucket.rebatesCents -= amount;
    }
    return;
  }
  if (row.accountType === AccountType.PLATFORM_PROFIT_POOL && row.direction === 'DEBIT') {
    bucket.profitShareCents += amount;
  }
}

export function serializeFinanceTrendDay(bucket: DayBucket) {
  const incomeCents = bucket.rakeCents + bucket.seatFeeCents + bucket.serviceFeeCents;
  const expenseCents = bucket.rewardsCents + bucket.rebatesCents + bucket.profitShareCents;
  return {
    date: bucket.date,
    rakeCents: String(bucket.rakeCents),
    seatFeeCents: String(bucket.seatFeeCents),
    serviceFeeCents: String(bucket.serviceFeeCents),
    rewardsCents: String(bucket.rewardsCents),
    rebatesCents: String(bucket.rebatesCents),
    profitShareCents: String(bucket.profitShareCents),
    incomeCents: String(incomeCents),
    expenseCents: String(expenseCents),
    netProfitCents: String(incomeCents - expenseCents),
    depositsCents: String(bucket.depositsCents),
    withdrawalsCents: String(bucket.withdrawalsCents),
  };
}

export async function getFinanceTrend(input: { days?: number; from?: string; to?: string }) {
  const dates = resolveFinanceTrendDates(input);
  const from = new Date(`${dates[0]}T00:00:00+08:00`);
  const until = new Date(`${dates[dates.length - 1]}T00:00:00+08:00`);
  until.setTime(until.getTime() + 86_400_000);
  const window = { gte: from, lt: until };
  const platformTypes: AccountType[] = [
    AccountType.PLATFORM_RAKE,
    AccountType.PLATFORM_FEES,
    AccountType.PLATFORM_REWARD,
    AccountType.PLATFORM_REBATE,
    AccountType.PLATFORM_PROFIT_POOL,
  ];

  const [ledger, deposits, withdrawals, pendingDeposits, pendingWithdrawals] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: {
        userId: null,
        createdAt: window,
        accountType: { in: platformTypes },
      },
      select: {
        accountType: true,
        direction: true,
        refType: true,
        amountCents: true,
        createdAt: true,
      },
    }),
    prisma.depositOrder.findMany({
      where: { status: 'COMPLETED', reviewedAt: window },
      select: { amountCents: true, reviewedAt: true },
    }),
    prisma.withdrawOrder.findMany({
      where: { status: 'COMPLETED', reviewedAt: window },
      select: { amountCents: true, reviewedAt: true },
    }),
    prisma.depositOrder.aggregate({
      where: { status: 'PENDING' },
      _count: { _all: true },
      _sum: { amountCents: true },
    }),
    prisma.withdrawOrder.aggregate({
      where: { status: 'PENDING' },
      _count: { _all: true },
      _sum: { amountCents: true },
    }),
  ]);

  const buckets = new Map(dates.map((date) => [date, emptyDay(date)]));
  for (const row of ledger) {
    const bucket = buckets.get(malaysiaDay(row.createdAt));
    if (bucket) applyFinanceTrendRow(bucket, row);
  }
  for (const row of deposits) {
    if (!row.reviewedAt) continue;
    const bucket = buckets.get(malaysiaDay(row.reviewedAt));
    if (bucket) bucket.depositsCents += row.amountCents;
  }
  for (const row of withdrawals) {
    if (!row.reviewedAt) continue;
    const bucket = buckets.get(malaysiaDay(row.reviewedAt));
    if (bucket) bucket.withdrawalsCents += row.amountCents;
  }

  return {
    items: dates.map((date) => serializeFinanceTrendDay(buckets.get(date) ?? emptyDay(date))),
    pendingDeposits: pendingDeposits._count._all,
    pendingWithdrawals: pendingWithdrawals._count._all,
    pendingDepositCents: String(pendingDeposits._sum.amountCents ?? 0n),
    pendingWithdrawalCents: String(pendingWithdrawals._sum.amountCents ?? 0n),
  };
}

export async function getCurrentRakeRates() {
  const settings = await getGameSettings(SUPREME_NIUNIU_GAME_CODE);
  const playerRatio = rakeRatioFor('PLAYER', settings.fees);
  const bankerRatio = rakeRatioFor('BANKER', settings.fees);
  return {
    playerPercent: formatRatioPercent(playerRatio),
    bankerPercent: formatRatioPercent(bankerRatio),
  };
}

export async function getPlayerFundAccounts() {
  const sums = await prisma.wallet.aggregate({
    where: { user: { kind: 'HUMAN' } },
    _sum: {
      availableCents: true,
      freezeBetCents: true,
      freezeBankerCents: true,
      freezeWithdrawCents: true,
    },
  });
  const asAccount = (accountType: AccountType, balance: bigint | null) => ({
    accountType,
    balanceCents: String(balance ?? 0n),
  });
  return [
    asAccount(AccountType.USER_AVAILABLE, sums._sum.availableCents),
    asAccount(AccountType.USER_FREEZE_BET, sums._sum.freezeBetCents),
    asAccount(AccountType.USER_FREEZE_BANKER, sums._sum.freezeBankerCents),
    asAccount(AccountType.USER_FREEZE_WITHDRAW, sums._sum.freezeWithdrawCents),
  ];
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export type FinanceOrderKind = 'deposit' | 'withdraw';
export type FinanceOrderStatusFilter = 'ALL' | OrderStatus;

export function financeOrderCreatedAt(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (from && !DATE_KEY.test(from)) from = undefined;
  if (to && !DATE_KEY.test(to)) to = undefined;
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00+08:00`) } : {}),
    ...(to ? { lt: new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86_400_000) } : {}),
  };
}

export function summarizeFinanceOrderStats(
  groups: Array<{ status: OrderStatus; count: number; amountCents: bigint }>,
) {
  const counts = { ALL: 0, PENDING: 0, COMPLETED: 0, REJECTED: 0 };
  const amounts = { ALL: 0n, PENDING: 0n, COMPLETED: 0n, REJECTED: 0n };
  for (const row of groups) {
    counts[row.status] = row.count;
    amounts[row.status] = row.amountCents;
    counts.ALL += row.count;
    amounts.ALL += row.amountCents;
  }
  return {
    counts,
    amounts: {
      ALL: String(amounts.ALL),
      PENDING: String(amounts.PENDING),
      COMPLETED: String(amounts.COMPLETED),
      REJECTED: String(amounts.REJECTED),
    },
  };
}

function financeOrderUserFilter(q?: string): Prisma.UserWhereInput | undefined {
  const keyword = q?.trim();
  if (!keyword) return undefined;
  return {
    OR: [
      { uid: { contains: keyword } },
      { nickname: { contains: keyword, mode: 'insensitive' } },
    ],
  };
}

function revealFinanceSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = { ...(value as Record<string, unknown>) };
  for (const field of ['duitnowId', 'name', 'bankAccount', 'holder', 'accountNo', 'accountName']) {
    if (typeof snapshot[field] === 'string') snapshot[field] = safeDecryptSecret(snapshot[field]);
  }
  return snapshot;
}

export async function getFinanceOrders(input: {
  kind: FinanceOrderKind;
  status?: FinanceOrderStatusFilter;
  page?: number;
  pageSize?: number;
  q?: string;
  from?: string;
  to?: string;
}) {
  const status = input.status ?? 'ALL';
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 30));
  const createdAt = financeOrderCreatedAt(input.from, input.to);
  const user = financeOrderUserFilter(input.q);
  const baseWhere = {
    ...(createdAt ? { createdAt } : {}),
    ...(user ? { user } : {}),
  };
  const listWhere = {
    ...baseWhere,
    ...(status === 'ALL' ? {} : { status }),
  };
  const userSelect = { id: true, uid: true, nickname: true } as const;
  const pendingFirst = status === 'PENDING';

  if (input.kind === 'deposit') {
    const [items, grouped] = await Promise.all([
      prisma.depositOrder.findMany({
        where: listWhere,
        include: { user: { select: userSelect } },
        orderBy: { createdAt: pendingFirst ? 'asc' : 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.depositOrder.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
    ]);
    const stats = summarizeFinanceOrderStats(
      grouped.map((row) => ({
        status: row.status,
        count: row._count._all,
        amountCents: row._sum.amountCents ?? 0n,
      })),
    );
    return {
      items: items.map(({ payeeSnapshot, ...item }) => ({
        ...item,
        payeeSnapshot: revealFinanceSnapshot(payeeSnapshot),
      })),
      total: status === 'ALL' ? stats.counts.ALL : stats.counts[status],
      page,
      pageSize,
      ...stats,
    };
  }

  const [items, grouped] = await Promise.all([
    prisma.withdrawOrder.findMany({
      where: listWhere,
      include: { user: { select: userSelect } },
      orderBy: { createdAt: pendingFirst ? 'asc' : 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.withdrawOrder.groupBy({
      by: ['status'],
      where: baseWhere,
      _count: { _all: true },
      _sum: { amountCents: true },
    }),
  ]);
  const stats = summarizeFinanceOrderStats(
    grouped.map((row) => ({
      status: row.status,
      count: row._count._all,
      amountCents: row._sum.amountCents ?? 0n,
    })),
  );
  return {
    items: items.map((item) => ({
      ...item,
      targetSnapshot: revealFinanceSnapshot(item.targetSnapshot),
    })),
    total: status === 'ALL' ? stats.counts.ALL : stats.counts[status],
    page,
    pageSize,
    ...stats,
  };
}

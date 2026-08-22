import { AccountType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { serializable } from '../lib/transaction.js';
import { DEFAULT_REBATE_CONFIG } from '../engine/rebate.js';
import { getGameConfig } from './gameConfig.js';
import { pushService } from './push.js';
import { transfer } from './wallet.js';

export function malaysiaDay(date = new Date()): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kuala_Lumpur' });
}

export const PROMOTION_RANGE_MAX_DAYS = 92;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function malaysiaDateFromKey(key: string) {
  return new Date(`${key}T00:00:00+08:00`);
}

function daysInclusive(from: string, to: string) {
  return (
    Math.round(
      (malaysiaDateFromKey(to).getTime() - malaysiaDateFromKey(from).getTime())
        / 86_400_000,
    ) + 1
  );
}

/** 推广页查询区间：兼容旧 `date`，支持 `from`/`to`，不超过今天且最多 92 天。 */
export function resolvePromotionPeriod(
  input: { date?: string; from?: string; to?: string },
  today = malaysiaDay(),
): { from: string; to: string } {
  const rawFrom = input.from ?? input.date ?? today;
  const rawTo = input.to ?? input.date ?? input.from ?? today;
  if (!DAY_KEY.test(rawFrom) || !DAY_KEY.test(rawTo)) {
    throw new Error('INVALID_PROMOTION_DATE');
  }
  let from = rawFrom;
  let to = rawTo;
  if (from > to) {
    [from, to] = [to, from];
  }
  if (to > today) to = today;
  if (from > today) from = today;
  if (from > to) {
    from = to;
  }
  if (daysInclusive(from, to) > PROMOTION_RANGE_MAX_DAYS) {
    throw new Error('PROMOTION_RANGE_TOO_LONG');
  }
  return { from, to };
}

export function previousMalaysiaDay(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return malaysiaDay(date);
}

function commissionPart(cents: bigint, rate: number): bigint {
  const millionths = BigInt(Math.round(rate * 1_000_000));
  return (cents * millionths + 500_000n) / 1_000_000n;
}

export function parseRebateRates(raw: unknown) {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const num = (key: string, fallback: number) => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    selfRate: num('selfRate', DEFAULT_REBATE_CONFIG.selfRate),
    l1Rate: num('l1Rate', DEFAULT_REBATE_CONFIG.l1Rate),
    l2Rate: num('l2Rate', DEFAULT_REBATE_CONFIG.l2Rate),
    includeTieBets: Boolean(source.includeTieBets ?? DEFAULT_REBATE_CONFIG.includeTieBets),
  };
}

export function rebateLayerBreakdown(
  selfCents: bigint,
  l1Cents: bigint,
  l2Cents: bigint,
  rates: { selfRate: number; l1Rate: number; l2Rate: number },
) {
  return [
    { key: 'self' as const, label: '自身有效流水', turnoverCents: selfCents, rate: rates.selfRate },
    { key: 'l1' as const, label: '直属有效流水', turnoverCents: l1Cents, rate: rates.l1Rate },
    { key: 'l2' as const, label: '二级有效流水', turnoverCents: l2Cents, rate: rates.l2Rate },
  ].map((layer) => ({
    key: layer.key,
    label: layer.label,
    turnoverCents: String(layer.turnoverCents),
    rate: layer.rate,
    commissionCents: String(commissionPart(layer.turnoverCents, layer.rate)),
  }));
}

export class RebateError extends Error {
  constructor(
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

function formatRm(cents: bigint) {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export async function settleRebates(
  date: string,
  gameCode?: string,
  options: { repayRevoked?: boolean } = {},
) {
  if (date >= malaysiaDay()) {
    throw new Error('REBATE_PERIOD_NOT_CLOSED');
  }
  const turnovers = await prisma.turnoverDaily.findMany({
    where: { date, gameCode },
  });
  const configByGame = new Map<
    string,
    Awaited<ReturnType<typeof rebateConfigForGame>>
  >();
  const paid = [];
  for (const turnover of turnovers) {
    let config = configByGame.get(turnover.gameCode);
    if (!config) {
      config = await rebateConfigForGame(turnover.gameCode);
      configByGame.set(turnover.gameCode, config);
    }
    const commission =
      commissionPart(turnover.selfCents, config.selfRate) +
      commissionPart(turnover.l1Cents, config.l1Rate) +
      commissionPart(turnover.l2Cents, config.l2Rate);
    const result = await serializable(async (tx) => {
      const existing = await tx.rebateSettlement.findUnique({
        where: {
          gameCode_userId_date: {
            gameCode: turnover.gameCode,
            userId: turnover.userId,
            date,
          },
        },
      });
      if (existing?.status === 'PAID') return null;
      if (existing && existing.status !== 'REVOKED') return null;
      if (existing?.status === 'REVOKED' && !options.repayRevoked) return null;

      const snapshot = {
        selfRate: config.selfRate,
        l1Rate: config.l1Rate,
        l2Rate: config.l2Rate,
        includeTieBets: config.includeTieBets,
      };
      const settlement = existing
        ? await tx.rebateSettlement.update({
            where: { id: existing.id },
            data: {
              selfCents: turnover.selfCents,
              l1Cents: turnover.l1Cents,
              l2Cents: turnover.l2Cents,
              ratesSnapshot: snapshot,
              commissionCents: commission,
              status: 'PAID',
            },
          })
        : await tx.rebateSettlement.create({
            data: {
              gameCode: turnover.gameCode,
              userId: turnover.userId,
              date,
              selfCents: turnover.selfCents,
              l1Cents: turnover.l1Cents,
              l2Cents: turnover.l2Cents,
              ratesSnapshot: snapshot,
              commissionCents: commission,
              status: 'PAID',
            },
          });
      const payKey = existing
        ? `rebate-repay:${settlement.id}`
        : `rebate:${turnover.gameCode}:${turnover.userId}:${date}`;
      if (commission > 0n) {
        await transfer(tx, {
          amountCents: commission,
          from: { accountType: AccountType.PLATFORM_REBATE },
          to: { userId: turnover.userId, accountType: AccountType.USER_AVAILABLE },
          refType: 'rebate',
          refId: settlement.id,
          idempotencyKey: payKey,
        });
      }
      await tx.rebateSettlement.update({
        where: { id: settlement.id },
        data: { ledgerRef: commission > 0n ? payKey : null },
      });
      return settlement;
    });
    if (result) {
      paid.push(result);
      if (commission > 0n) {
        void pushService
          .sendCustom(
            turnover.userId,
            `💰 ${date} ${turnover.gameCode} 推广返水已结算\n佣金 RM${formatRm(commission)} 已发放到可用余额。`,
          )
          .catch(() => undefined);
      }
    }
  }
  return rebateOrderForDate(date, paid.length);
}

export async function rebateOrderForDate(date: string, createdCount = 0) {
  const items = await prisma.rebateSettlement.findMany({
    where: { date },
    include: { user: { select: { uid: true, nickname: true } } },
    orderBy: { createdAt: 'desc' },
    take: 1_000,
  });
  const userIds = [...new Set(items.map((item) => item.userId))];
  const downlines =
    userIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: {
            OR: [
              { inviterId: { in: userIds } },
              { grandInviterId: { in: userIds } },
            ],
          },
          select: {
            id: true,
            uid: true,
            nickname: true,
            inviterId: true,
            grandInviterId: true,
          },
        });
  const downlineIds = [...new Set(downlines.map((user) => user.id))];
  const contributorTurnovers =
    downlineIds.length === 0
      ? []
      : await prisma.turnoverDaily.findMany({
          where: { userId: { in: downlineIds }, date },
          select: { userId: true, gameCode: true, selfCents: true },
        });
  const turnoverByUserGame = new Map(
    contributorTurnovers.map((row) => [`${row.userId}:${row.gameCode}`, row.selfCents]),
  );
  const paid = items.filter((item) => item.status === 'PAID');
  return {
    date,
    createdCount,
    paidCount: paid.length,
    revokedCount: items.filter((item) => item.status === 'REVOKED').length,
    totalCommissionCents: String(
      paid.reduce((total, item) => total + item.commissionCents, 0n),
    ),
    funding: {
      from: '推广返水支出户',
      to: '玩家可用余额',
      fromAccount: AccountType.PLATFORM_REBATE,
      toAccount: AccountType.USER_AVAILABLE,
    },
    items: items.map((item) => {
      const rates = parseRebateRates(item.ratesSnapshot);
      const breakdown = rebateLayerBreakdown(
        item.selfCents,
        item.l1Cents,
        item.l2Cents,
        rates,
      );
      const contributors = attachRebateContributors(
        item,
        rates,
        downlines,
        turnoverByUserGame,
      );
      return {
        ...item,
        gameTitle: item.gameCode === 'SUPREME_NIUNIU' ? '至尊牛牛' : item.gameCode,
        rates,
        breakdown,
        contributors,
      };
    }),
  };
}

function attachRebateContributors(
  item: { userId: string; gameCode: string; l1Cents: bigint; l2Cents: bigint },
  rates: { l1Rate: number; l2Rate: number },
  downlines: Array<{
    id: string;
    uid: string;
    nickname: string;
    inviterId: string | null;
    grandInviterId: string | null;
  }>,
  turnoverByUserGame: Map<string, bigint>,
) {
  const contributors: Array<{
    level: 1 | 2;
    userId: string | null;
    uid: string | null;
    nickname: string;
    turnoverCents: string;
    commissionCents: string;
  }> = [];
  let attributedL1 = 0n;
  let attributedL2 = 0n;
  for (const downline of downlines) {
    const turnover = turnoverByUserGame.get(`${downline.id}:${item.gameCode}`) ?? 0n;
    if (turnover <= 0n) continue;
    if (downline.inviterId === item.userId) {
      attributedL1 += turnover;
      contributors.push({
        level: 1,
        userId: downline.id,
        uid: downline.uid,
        nickname: downline.nickname,
        turnoverCents: String(turnover),
        commissionCents: String(commissionPart(turnover, rates.l1Rate)),
      });
    }
    if (downline.grandInviterId === item.userId) {
      attributedL2 += turnover;
      contributors.push({
        level: 2,
        userId: downline.id,
        uid: downline.uid,
        nickname: downline.nickname,
        turnoverCents: String(turnover),
        commissionCents: String(commissionPart(turnover, rates.l2Rate)),
      });
    }
  }
  if (item.l1Cents > attributedL1) {
    const leftover = item.l1Cents - attributedL1;
    contributors.push({
      level: 1,
      userId: null,
      uid: null,
      nickname: '已解绑或已清理的直属',
      turnoverCents: String(leftover),
      commissionCents: String(commissionPart(leftover, rates.l1Rate)),
    });
  }
  if (item.l2Cents > attributedL2) {
    const leftover = item.l2Cents - attributedL2;
    contributors.push({
      level: 2,
      userId: null,
      uid: null,
      nickname: '已解绑或已清理的二级',
      turnoverCents: String(leftover),
      commissionCents: String(commissionPart(leftover, rates.l2Rate)),
    });
  }
  return contributors.sort((a, b) => a.level - b.level || Number(BigInt(b.turnoverCents) - BigInt(a.turnoverCents)));
}

async function revokeOneSettlement(
  tx: Parameters<Parameters<typeof serializable>[0]>[0],
  settlement: {
    id: string;
    userId: string;
    date: string;
    gameCode: string;
    commissionCents: bigint;
    status: string;
  },
  operatorId?: string,
) {
  if (settlement.status !== 'PAID') {
    throw new RebateError('REBATE_NOT_PAID');
  }
  if (settlement.commissionCents > 0n) {
    try {
      await transfer(tx, {
        amountCents: settlement.commissionCents,
        from: { userId: settlement.userId, accountType: AccountType.USER_AVAILABLE },
        to: { accountType: AccountType.PLATFORM_REBATE },
        refType: 'rebate_revoke',
        refId: settlement.id,
        idempotencyKey: `rebate-revoke:${settlement.id}`,
        operatorId,
        memo: `撤回 ${settlement.date} 推广返水`,
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'INSUFFICIENT_BALANCE') {
        throw new RebateError('REBATE_REVOKE_INSUFFICIENT', {
          userId: settlement.userId,
        });
      }
      throw error;
    }
  }
  return tx.rebateSettlement.update({
    where: { id: settlement.id },
    data: { status: 'REVOKED', ledgerRef: `rebate-revoke:${settlement.id}` },
  });
}

export async function revokeRebateSettlement(id: string, operatorId?: string) {
  const revoked = await serializable(async (tx) => {
    const settlement = await tx.rebateSettlement.findUnique({ where: { id } });
    if (!settlement) throw new RebateError('REBATE_NOT_FOUND');
    return revokeOneSettlement(tx, settlement, operatorId);
  });
  if (revoked.commissionCents > 0n) {
    void pushService
      .sendCustom(
        revoked.userId,
        `⚠️ ${revoked.date} 推广返水已撤回\n已从可用余额扣回 RM${formatRm(revoked.commissionCents)}。`,
      )
      .catch(() => undefined);
  }
  return rebateOrderForDate(revoked.date);
}

export async function revokeRebateOrder(date: string, operatorId?: string) {
  const paid = await prisma.rebateSettlement.findMany({
    where: { date, status: 'PAID' },
  });
  if (paid.length === 0) throw new RebateError('REBATE_ORDER_EMPTY');
  await serializable(async (tx) => {
    for (const settlement of paid) {
      await revokeOneSettlement(tx, settlement, operatorId);
    }
  });
  for (const settlement of paid) {
    if (settlement.commissionCents <= 0n) continue;
    void pushService
      .sendCustom(
        settlement.userId,
        `⚠️ ${date} 推广返水已撤回\n已从可用余额扣回 RM${formatRm(settlement.commissionCents)}。`,
      )
      .catch(() => undefined);
  }
  return rebateOrderForDate(date);
}

async function rebateConfigForGame(gameCode: string) {
  return getGameConfig(gameCode, 'rebate', DEFAULT_REBATE_CONFIG);
}

export async function estimatedCommission(userId: string, date = malaysiaDay()) {
  return estimatedCommissionInRange(userId, date, date);
}

export async function estimatedCommissionInRange(
  userId: string,
  from: string,
  to: string,
) {
  const date = from === to ? from : { gte: from, lte: to };
  const [turnovers, settlements] = await Promise.all([
    prisma.turnoverDaily.findMany({ where: { userId, date } }),
    prisma.rebateSettlement.findMany({ where: { userId, date } }),
  ]);
  const settledByKey = new Map(
    settlements.map((settlement) => [
      `${settlement.date}:${settlement.gameCode}`,
      settlement,
    ]),
  );
  let total = 0n;
  for (const turnover of turnovers) {
    const settlement = settledByKey.get(`${turnover.date}:${turnover.gameCode}`);
    if (settlement && settlement.status !== 'REVOKED') {
      total += settlement.commissionCents;
      continue;
    }
    const config = await rebateConfigForGame(turnover.gameCode);
    total +=
      commissionPart(turnover.selfCents, config.selfRate) +
      commissionPart(turnover.l1Cents, config.l1Rate) +
      commissionPart(turnover.l2Cents, config.l2Rate);
  }
  return total;
}

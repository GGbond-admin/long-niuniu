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

export async function settleRebates(date: string, gameCode?: string) {
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
      if (existing) return null;
      const settlement = await tx.rebateSettlement.create({
        data: {
          gameCode: turnover.gameCode,
          userId: turnover.userId,
          date,
          selfCents: turnover.selfCents,
          l1Cents: turnover.l1Cents,
          l2Cents: turnover.l2Cents,
          ratesSnapshot: {
            selfRate: config.selfRate,
            l1Rate: config.l1Rate,
            l2Rate: config.l2Rate,
            includeTieBets: config.includeTieBets,
          },
          commissionCents: commission,
          status: 'PAID',
        },
      });
      if (commission > 0n) {
        await transfer(tx, {
          amountCents: commission,
          from: { accountType: AccountType.PLATFORM_REBATE },
          to: { userId: turnover.userId, accountType: AccountType.USER_AVAILABLE },
          refType: 'rebate',
          refId: settlement.id,
          idempotencyKey: `rebate:${turnover.gameCode}:${turnover.userId}:${date}`,
        });
      }
      await tx.rebateSettlement.update({
        where: { id: settlement.id },
        data: {
          ledgerRef:
            commission > 0n
              ? `rebate:${turnover.gameCode}:${turnover.userId}:${date}`
              : null,
        },
      });
      return settlement;
    });
    if (result) {
      paid.push(result);
      if (commission > 0n) {
        const amount = `${commission / 100n}.${(commission % 100n).toString().padStart(2, '0')}`;
        void pushService
          .sendCustom(
            turnover.userId,
            `💰 ${date} ${turnover.gameCode} 推广返水已结算\n佣金 RM${amount} 已发放到可用余额。`,
          )
          .catch(() => undefined);
      }
    }
  }
  return paid;
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
    if (settlement) {
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

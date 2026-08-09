import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  GAME_CATALOG,
  SUPPORTED_GAME_CODES,
  SUPREME_NIUNIU_GAME_CODE,
  type SupportedGameCode,
} from './gameCatalog.js';
import { type GameSettings } from './gameSettings.js';

const htmlTag = /<\/?[a-z][^>]*>/i;
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !htmlTag.test(value), {
      message: '规则内容只允许纯文本，不允许 HTML 标签',
    });

export const gameRuleDocumentInput = z
  .object({
    title: plainText(80),
    summary: z
      .string()
      .trim()
      .max(500)
      .refine((value) => !htmlTag.test(value), {
        message: '规则摘要只允许纯文本，不允许 HTML 标签',
      })
      .default(''),
    sections: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/),
            title: plainText(80),
            body: plainText(4_000),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .superRefine((sections, ctx) => {
        const seen = new Set<string>();
        sections.forEach((section, index) => {
          if (seen.has(section.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: '规则 section id 不可重复',
              path: [index, 'id'],
            });
          }
          seen.add(section.id);
        });
      }),
    status: z.enum(['DRAFT', 'PUBLISHED']).default('PUBLISHED'),
  })
  .strict();

export type GameRuleDocumentInput = z.infer<typeof gameRuleDocumentInput>;

const supremeSections: GameRuleDocumentInput['sections'] = [
  {
    id: 'flow',
    title: '游戏流程',
    body: '竞标庄家 → 玩家下注 → 庄家投骰 → 发放红包 → 玩家抢包 → 系统按牌型自动结算。',
  },
  {
    id: 'hands',
    title: '牌型与大小',
    body: '系统根据红包金额尾数计算牛牛牌型；同牌型按点数及既定优先级比较，具体倍数以本页实时配置为准。',
  },
  {
    id: 'betting',
    title: '下注与梭哈',
    body: '仅在下注阶段接受操作。普通下注、梭哈范围及竞标上下限由当前游戏配置决定，封盘后不可修改。',
  },
  {
    id: 'settlement',
    title: '结算与费用',
    body: '余额先冻结后结算，取消局原路退回。玩家盈利抽水、庄家盈利抽水及相关费用以本局配置快照为准。',
  },
  {
    id: 'fairness',
    title: '公平与风险提示',
    body: '每局开始时冻结规则快照，后台后续修改只影响下一局。请理性参与并妥善保管账户及支付密码。',
  },
];

function defaultRuleDocument(
  gameCode: SupportedGameCode,
): GameRuleDocumentInput {
  const game = GAME_CATALOG[gameCode];
  if (gameCode === SUPREME_NIUNIU_GAME_CODE) {
    return {
      title: '至尊牛牛游戏规则',
      summary:
        '抢红包比牌型，庄闲实时结算。所有资金数值以开局时冻结的游戏配置为准。',
      sections: supremeSections,
      status: 'PUBLISHED',
    };
  }
  return {
    title: `${game.title}游戏规则`,
    summary: '所有资金数值以开局时冻结的游戏配置为准。',
    sections: [
      {
        id: 'overview',
        title: '玩法说明',
        body: '请以当前页面发布的规则、配置及局内提示为准。',
      },
      {
        id: 'fairness',
        title: '配置生效',
        body: '每局开始时冻结规则快照，后台后续修改只影响下一局。',
      },
    ],
    status: 'PUBLISHED',
  };
}

export async function ensureGameRuleDefaults(): Promise<void> {
  for (const gameCode of SUPPORTED_GAME_CODES) {
    const defaults = defaultRuleDocument(gameCode);
    await prisma.gameRuleDocument.upsert({
      where: { gameCode },
      create: {
        gameCode,
        title: defaults.title,
        summary: defaults.summary,
        sections: defaults.sections as Prisma.InputJsonValue,
        status: defaults.status,
        version: 1,
        updatedBy: 'SYSTEM',
        publishedAt: new Date(),
      },
      update: {},
    });
  }
}

export async function getAdminGameRules(gameCode: string) {
  return prisma.gameRuleDocument.findUnique({ where: { gameCode } });
}

export async function getPublishedGameRules(gameCode: string) {
  return prisma.gameRuleDocument.findFirst({
    where: { gameCode, status: 'PUBLISHED' },
  });
}

export async function saveGameRules(
  gameCode: string,
  input: GameRuleDocumentInput,
  updatedBy: string,
) {
  const parsed = gameRuleDocumentInput.parse(input);
  const before = await prisma.gameRuleDocument.findUnique({
    where: { gameCode },
  });
  const publishedAt =
    parsed.status === 'PUBLISHED'
      ? new Date()
      : before?.publishedAt ?? null;
  const document = await prisma.gameRuleDocument.upsert({
    where: { gameCode },
    create: {
      gameCode,
      title: parsed.title,
      summary: parsed.summary,
      sections: parsed.sections as Prisma.InputJsonValue,
      status: parsed.status,
      version: 1,
      updatedBy,
      publishedAt,
    },
    update: {
      title: parsed.title,
      summary: parsed.summary,
      sections: parsed.sections as Prisma.InputJsonValue,
      status: parsed.status,
      version: { increment: 1 },
      updatedBy,
      publishedAt,
    },
  });
  return { before, document };
}

export function ruleConfigSummary(settings: GameSettings) {
  return {
    hand: {
      multipliers: settings.hand.multipliers,
      normalMultipliers: settings.hand.normalMultipliers,
      bustThreshold: settings.hand.bustThreshold,
      bustExemptSpecialHands: settings.hand.bustExemptSpecialHands,
    },
    betting: settings.betting,
    fees: settings.fees,
    round: {
      bidDurationSeconds: settings.round.bidDurationSeconds,
      betDurationSeconds: settings.round.betDurationSeconds,
      claimDurationSeconds: settings.round.claimDurationSeconds,
      continuationWindowSeconds:
        settings.round.continuationWindowSeconds,
      bankerBidMinCents: settings.round.bankerBidMinCents,
      bankerBidMaxCents: settings.round.bankerBidMaxCents,
    },
  };
}

export function summarizeRuleChanges(
  before: Awaited<ReturnType<typeof getAdminGameRules>>,
  after: Awaited<ReturnType<typeof getAdminGameRules>>,
): string[] {
  if (!after) return [];
  if (!before) return ['创建规则文档'];
  const changes: string[] = [];
  if (before.title !== after.title) changes.push('规则标题');
  if (before.summary !== after.summary) changes.push('规则摘要');
  if (JSON.stringify(before.sections) !== JSON.stringify(after.sections)) {
    changes.push('规则章节');
  }
  if (before.status !== after.status) changes.push('发布状态');
  return changes;
}

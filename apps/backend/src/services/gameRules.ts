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
    id: 'overview',
    title: '游戏简介',
    body:
      '至尊牛牛是基于 Touch n Go eWallet 红包链接的多人对战玩法。\n' +
      '每局由一位玩家通过竞标庄钱做「庄家」，闲家自由下注，系统统一发出 TNG 红包链接，按抢到的金额识别「点数 / 牌型」并比对庄闲大小，胜者按倍数赢取庄家筹码，平台抽取小额抽水。',
  },
  {
    id: 'where-to-play',
    title: '在哪里玩',
    body:
      '本游戏在「至尊牛牛互动群」内进行，请先进入「我的消息 → 至尊牛牛互动群」参与对局。竞标庄钱、下注、抢包等动作都在该群内完成。',
  },
  {
    id: 'roles',
    title: '角色说明',
    body:
      '庄家：通过竞标庄钱上庄获得的玩家，承担本局所有闲家的输赢，赔付上限为庄池金额。\n' +
      '闲家：未做庄的其他玩家，可在下注阶段下注与庄家对赌；不下注即视为本局弃权。',
  },
  {
    id: 'flow',
    title: '游戏流程',
    body:
      '1. 大厅阶段\n' +
      '玩家进入对应群组房间等待开局；系统在凑够最低人数后自动开启下一局。\n' +
      '2. 上庄 · 竞标庄钱\n' +
      '所有玩家可在倒计时内输入整数金额竞标庄钱；首口自由输入，之后最低需要比当前最高价高 100，也可以加更多，低于最低加价会被拒绝。最高出价者成为本局庄家，相应金额从余额中冻结作「庄池」。\n' +
      '续庄：上一局做庄的玩家如果选择续庄，将沿用上一局的庄钱继续做庄，无需再次竞标；同一玩家每桌仅可续庄一次。\n' +
      '无人竞标庄钱：本局取消，不进入下注阶段。\n' +
      '余额不足：系统会拒绝竞标并退回出价。\n' +
      '3. 下注阶段\n' +
      '除庄家外的玩家可在「下注范围」内下注，倒计时结束即停止；也可选择梭哈。\n' +
      '普通下注：系统按本局最高牌型倍数（默认 17 倍）计算余额可承担的最高下注；输入过高时自动降低并显示实际接受金额。\n' +
      '梭哈：赔付固定 1:1，最低默认 30，房间上限 = 庄钱 × 满梭哈比例（默认 5%）× 人数系数，再与当前余额取较小值。\n' +
      '未下注：视为本局弃权，不参与结算（不赢不输）。\n' +
      '下注成功：系统按「实际下注 × 赔付倍数」冻结最大赔付预留金（普通=本局最高倍数、梭哈=1 倍），撤回或结算后退回未使用部分。\n' +
      '4. 系统发包\n' +
      '下注阶段结束后，系统统一发出 TNG 红包链接到游戏群。庄家与所有已下注的闲家依次抢包；抢到金额即为本人本局的「红包金额」。\n' +
      '5. 抢额识别\n' +
      '系统按红包金额的小数与整数位计算「点数」与「牌型」（详见下方「点数计算」「牌型与倍数」章节）。\n' +
      '6. 结算\n' +
      '系统逐个比对庄家与闲家的牌型 / 点数，按倍数结算并扣除抽水：\n' +
      '闲家赢：庄家从庄池支付倍数 × 下注，平台抽取闲赢抽水（默认 3%）。\n' +
      '闲家输：按庄家牌型倍数从闲家预留金全额赔付；庄家抽水按本局对赌毛利的 5%，亏损不抽。\n' +
      '梭哈单：无论牌型多大，赢只按 1:1 拿等额下注（同样扣闲赢抽水）、输只赔等额下注。\n' +
      '同牌型按该牌型规则比较；比较键相同则平局退回。\n' +
      '7. 庄钱不足时的赔付顺序\n' +
      '庄钱就是庄家本局可赔付的最高金额，赔完即止。当庄钱不够赔付全部赢家时，普通与梭哈的赢家一起排队，按以下顺序依次赔付：\n' +
      '① 牌型等级高的先赔（梭哈也按自己抢到的牌型排队）；② 同牌型按该牌型比较规则（普通比点数；对子先后两位再前位；金牛比中间位；其余比金额）；③ 以上全同时下注时间早的先赔。\n' +
      '轮到某位赢家时庄钱不足全额，则把剩余庄钱全部赔给他；庄钱归零后，排在后面的赢家「喝水」，不获得任何赔付，但下注冻结金额全额退回、不会倒扣。',
  },
  {
    id: 'points',
    title: '点数计算',
    body:
      '将红包金额的三位关键数字相加，取个位数即为「点数」。\n' +
      '例：3.42　3 + 4 + 2 = 9　9 点；1.28　1 + 2 + 8 = 11　1 点\n' +
      '三位数字相加刚好等于 10 时不按点数计算，直接判为「牛牛」牌型。\n' +
      '相加超过 10 取个位；个位为 0（如相加为 20）记为 0 点，是最小点数。',
  },
  {
    id: 'hands',
    title: '牌型与倍数（由高到低）',
    body:
      '豹子（17 倍）：三位数字全部相同，如 1.11 / 7.77 / 9.99。\n' +
      '满牛（15 倍）：后两位为 00，如 1.00 / 5.00 / 88.00。\n' +
      '顺子（13 倍）：三位数字连续递增，如 0.12 / 1.23 / 7.89（0 可作起点）。\n' +
      '反顺（14 倍）：三位数字连续递减，如 9.87 / 3.21 / 2.10；最大 9.87。0.98 也算倒顺。\n' +
      '对子（12 倍）：末两位相同非零数字，如 1.22 / 7.55。\n' +
      '金牛（11 倍）：0.X0 形式（X = 1–9），如 0.10 / 0.50 / 0.90。\n' +
      '牛牛（10 倍）：三位数字相加刚好等于 10，如 2.35 / 1.36 / 5.50。\n' +
      '普通：按 0–9 点数倍数结算。\n' +
      '同时符合多个牌型时取上表更高的牌型；实际倍数以游戏内显示为准（与后台配置实时同步）。',
  },
  {
    id: 'comparison',
    title: '牌型比较规则',
    body:
      '先比牌型等级：豹子 ＞ 满牛 ＞ 顺子 ＞ 反顺 ＞ 对子 ＞ 金牛 ＞ 牛牛 ＞ 普通。\n' +
      '等级不同：高等级胜。\n' +
      '等级相同后按该牌型自己的规则比较：\n' +
      '普通：先比点数（牛牛/10点 ＞ 9点 ＞ … ＞ 1点 ＞ 0点），同点再比金额。\n' +
      '豹子 / 满牛 / 顺子 / 反顺 / 牛牛：比整笔金额。\n' +
      '对子：先比后两位（99 ＞ 88 ＞ … ＞ 11），后两位相同再比前一位（例：8.99 赢 9.88；9.22 赢 1.22）。\n' +
      '金牛：只比中间金额，前后不算（例：0.90 赢 0.10）。\n' +
      '比较键相同：视为平局，本对不结算（双方下注金额原路返回）。\n' +
      '例：1.22 平 1.22；2.80 平 2.80。',
  },
  {
    id: 'banker',
    title: '如果您是庄家',
    body:
      '本局所有已下注的闲家与您对赌。\n' +
      '赔付总额以「庄池」（您的中标金额）为上限，不会超过庄池亏损。\n' +
      '庄家本局对赌毛利为正时，平台从该毛利抽取庄家抽水（默认 5%）；亏损不抽。\n' +
      '本局结束后可选择「续庄」，沿用相同的庄钱继续坐庄；同一玩家每桌仅可续庄一次。',
  },
  {
    id: 'player',
    title: '如果您是闲家',
    body:
      '请在下注倒计时内完成下注；超时未下注视为弃权，不参与结算。\n' +
      '普通下注最高可下注 = 当前可承担余额 ÷ 本局最高牌型倍数（默认 17），向下取整到元；超过时系统自动按最高可下注额接受。\n' +
      '梭哈最高可下注 = min(当前余额, 庄钱 × 满梭哈比例 × 人数系数)，默认满梭哈 5%。\n' +
      '赢家：普通下注按牌型倍数 × 您的下注获得收益，梭哈固定 1:1（均扣闲赢抽水）。\n' +
      '输家：普通下注按庄家牌型倍数、梭哈按 1 倍从已冻结的最大赔付预留金扣除，剩余预留金自动退回。\n' +
      '未下注 / 弃权：本局对您不结算，余额不变。',
  },
  {
    id: 'rewards',
    title: '棋牌奖励',
    body:
      '每日抢到指定牌型组合即可领取额外奖励：\n' +
      '豹子王（豹子 ×3）：奖励 288.88。\n' +
      '满牛王（满牛 ×3）：奖励 288.88。\n' +
      '顺子王（顺子 ×3）：奖励 188.88。\n' +
      '反顺王（反顺 ×3）：奖励 188.88。\n' +
      '每日 0 点重新计算，未完成的进度不会跨天累计。具体牌型要求与奖励金额以游戏内公告为准。',
  },
  {
    id: 'special-cases',
    title: '特殊情况',
    body:
      '无人竞标庄钱上庄：本局自动取消，无人参与结算。\n' +
      '下注阶段无人下注：本局取消，庄池金额全额退回庄家。\n' +
      '红包链接异常 / 失效：系统自动取消本局，所有冻结金额原路退回。\n' +
      '抢包超时：未抢部分按规则自动结算或退回。',
  },
  {
    id: 'notes',
    title: '注意事项',
    body:
      '上庄前请确认账户余额足够覆盖庄池；不足将自动退回竞标庄钱。\n' +
      '红包链接由系统统一发出，禁止玩家私下分享或冒充系统链接。\n' +
      '抢包顺序按操作时间确定，请提前准备 TNG 客户端。\n' +
      '牌型 / 倍数 / 抽水比例 / 服务费等数值会根据运营情况调整，请以游戏内显示为准。',
  },
];

function defaultRuleDocument(
  gameCode: SupportedGameCode,
): GameRuleDocumentInput {
  const game = GAME_CATALOG[gameCode];
  if (gameCode === SUPREME_NIUNIU_GAME_CODE) {
    return {
      title: '至尊牛牛玩法规则',
      summary: '',
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

function replaceLegacySupremeBrand(value: string): string {
  return value.replace(/12(?:年)?牛牛?/g, '至尊牛牛');
}

function replaceLegacyBrandInSections(
  sections: Prisma.JsonValue,
): Prisma.InputJsonValue {
  return JSON.parse(
    replaceLegacySupremeBrand(JSON.stringify(sections)),
  ) as Prisma.InputJsonValue;
}

function sectionIds(sections: Prisma.JsonValue): string[] {
  if (!Array.isArray(sections)) return [];
  return sections.flatMap((section) => {
    if (
      section &&
      typeof section === 'object' &&
      !Array.isArray(section) &&
      typeof section.id === 'string'
    ) {
      return [section.id];
    }
    return [];
  });
}

const LEGACY_SUPREME_SECTION_IDS = 'flow,hands,betting,settlement,fairness';

/**
 * 仍由系统维护的至尊牛牛规则：早期 seed 数据没有写 updatedBy；
 * 章节结构必须是旧版或当前系统版，管理员发布过的内容不可自动覆盖。
 */
function isSystemAuthoredSupremeRules(document: {
  updatedBy: string | null;
  sections: Prisma.JsonValue;
}): boolean {
  if (document.updatedBy !== null && document.updatedBy !== 'SYSTEM') return false;
  const ids = sectionIds(document.sections).join(',');
  return (
    ids === LEGACY_SUPREME_SECTION_IDS ||
    ids === supremeSections.map((section) => section.id).join(',')
  );
}

export async function ensureGameRuleDefaults(): Promise<void> {
  for (const gameCode of SUPPORTED_GAME_CODES) {
    const defaults = defaultRuleDocument(gameCode);
    const existing = await prisma.gameRuleDocument.findUnique({
      where: { gameCode },
    });
    // 系统版规则随代码内默认文案演进（如梭哈 1:1），管理员改写过的版本保持不动
    const refreshSystemDefaults =
      gameCode === SUPREME_NIUNIU_GAME_CODE &&
      !!existing &&
      isSystemAuthoredSupremeRules(existing) &&
      (existing.title !== defaults.title ||
        existing.summary !== defaults.summary ||
        JSON.stringify(existing.sections) !== JSON.stringify(defaults.sections));
    const normalizedTitle = existing
      ? replaceLegacySupremeBrand(existing.title)
      : '';
    const normalizedSummary = existing
      ? replaceLegacySupremeBrand(existing.summary)
      : '';
    const normalizedSections = existing
      ? replaceLegacyBrandInSections(existing.sections)
      : ([] as Prisma.InputJsonValue);
    const hasLegacyBrand =
      !!existing &&
      (normalizedTitle !== existing.title ||
        normalizedSummary !== existing.summary ||
        JSON.stringify(normalizedSections) !== JSON.stringify(existing.sections));

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
      update: refreshSystemDefaults
        ? {
            title: defaults.title,
            summary: defaults.summary,
            sections: defaults.sections as Prisma.InputJsonValue,
            status: defaults.status,
            version: { increment: 1 },
            updatedBy: 'SYSTEM',
            publishedAt: new Date(),
          }
        : hasLegacyBrand
          ? {
              title: normalizedTitle,
              summary: normalizedSummary,
              sections: normalizedSections,
              version: { increment: 1 },
            }
          : {},
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

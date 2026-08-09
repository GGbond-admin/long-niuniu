import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { BettingConfig, DEFAULT_BETTING_CONFIG } from '../engine/betting.js';
import { DEFAULT_FEE_CONFIG, FeeConfig } from '../engine/fees.js';
import { DEFAULT_HAND_CONFIG, HandConfig } from '../engine/hand.js';
import { DEFAULT_REBATE_CONFIG, RebateConfig } from '../engine/rebate.js';
import { prisma } from '../lib/prisma.js';
import { deepMerge, getGameConfig, setGameConfig } from './gameConfig.js';
import {
  GAME_CATALOG,
  SUPPORTED_GAME_CODES,
  SUPREME_NIUNIU_GAME_CODE,
  type SupportedGameCode,
} from './gameCatalog.js';

export interface RoundConfig {
  bidDurationSeconds: number;
  betDurationSeconds: number;
  claimDurationSeconds: number;
  continuationWindowSeconds: number;
  bankerBidMinCents: number;
  bankerBidMaxCents: number;
  trendLength: number;
  /**
   * 小助手服务总开关。关闭后：群内不再自动播报，也不会自动开局。
   * 与「游戏入口」无关——入口关闭只是玩家进不了互动群。
   */
  assistantEnabled: boolean;
  /**
   * 自动开局。仅在 assistantEnabled=true 时生效；默认关闭，需运营手动点「正常开局」或打开本开关。
   */
  autoStart: boolean;
  /** 自动认尾包：抢包超时后为未领取参与者系统补录尾包金额 */
  autoTailPacketEnabled: boolean;
  /** 自动发包：封盘后用 TNG_AUTO_PACKET_URL_TEMPLATE 自动登记链接并开抢 */
  autoPublishPacketEnabled: boolean;
  /** 代包手展示名（封盘播报用） */
  tailPackerBankerName: string;
  tailPackerPlayerName: string;
}

export const DEFAULT_ROUND_CONFIG: RoundConfig = {
  /** 竞标出价窗口：全员可出价；结束后进入 3/2/1 最终确认再锁定庄家 */
  bidDurationSeconds: 30,
  betDurationSeconds: 50,
  claimDurationSeconds: 30,
  continuationWindowSeconds: 15,
  bankerBidMinCents: 10_000,
  bankerBidMaxCents: 100_000_000,
  trendLength: 10,
  assistantEnabled: true,
  /** 默认不自动开局，避免一开入口就空转取消 */
  autoStart: false,
  autoTailPacketEnabled: false,
  autoPublishPacketEnabled: false,
  tailPackerBankerName: '代包手·庄家尾包',
  tailPackerPlayerName: '代包手·闲家尾包',
};

const assistantGateByRoom = new Map<
  string,
  { enabled: boolean; expiresAt: number }
>();

/** 同步门闩：供 systemChat 等热路径使用；每个游戏房间独立缓存。 */
export function isAssistantEnabledSync(roomId: string): boolean {
  const gate = assistantGateByRoom.get(roomId) ?? {
    enabled: true,
    expiresAt: 0,
  };
  if (gate.expiresAt <= Date.now()) {
    void refreshAssistantGate(roomId);
  }
  return gate.enabled;
}

export async function gameCodeForRoom(roomId: string): Promise<string> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { gameCode: true },
  });
  if (!room) throw new Error('ROOM_NOT_FOUND');
  return room.gameCode;
}

export async function refreshAssistantGate(roomId: string): Promise<boolean> {
  const gameCode = await gameCodeForRoom(roomId);
  const round = await getGameConfig(gameCode, 'round', DEFAULT_ROUND_CONFIG);
  const enabled = round.assistantEnabled !== false;
  assistantGateByRoom.set(roomId, {
    enabled,
    expiresAt: Date.now() + 10_000,
  });
  return enabled;
}

export async function isAssistantEnabled(roomId: string): Promise<boolean> {
  return refreshAssistantGate(roomId);
}

/** 关键阶段写完成标记前绕过进程缓存读取数据库，确保多实例暂停语义一致。 */
export async function isAssistantEnabledFresh(roomId: string): Promise<boolean> {
  const gameCode = await gameCodeForRoom(roomId);
  const row = await prisma.gameConfig.findUnique({
    where: { gameCode_key: { gameCode, key: 'round' } },
  });
  const round = row
    ? deepMerge(DEFAULT_ROUND_CONFIG, row.value)
    : DEFAULT_ROUND_CONFIG;
  const enabled = round.assistantEnabled !== false;
  assistantGateByRoom.set(roomId, {
    enabled,
    expiresAt: Date.now() + 10_000,
  });
  return enabled;
}

export interface RewardRules {
  minBetCents: number;
  minAllInCents: number;
  bankerInstantAmountCents: number;
}

export const DEFAULT_REWARD_RULES: RewardRules = {
  minBetCents: 500,
  minAllInCents: 5_000,
  bankerInstantAmountCents: 1,
};

/** 群内播报文案模板（后台可配，支持 {{变量}} 占位符） */
export interface MessageTemplates {
  welcome: string;
  bidStart: string;
  /** 有人出价时实时播报 */
  bidPlaced: string;
  /** @deprecated 旧版「名单在倒计时前」模板，仅保留配置兼容 */
  bidClosing: string;
  /** 出价窗口结束，先提示即将开始 3/2/1 */
  bidCountdownStart: string;
  bidCountdown3: string;
  bidCountdown2: string;
  bidCountdown1: string;
  /** 3/2/1 完成后公布最终出价名单 */
  bidFinalList: string;
  /** 竞标结束后小助手 @ 宣布本局庄家 */
  bankerSelected: string;
  betStart: string;
  sealed: string;
  sealedSummary: string;
  dicePrompt: string;
  betCountdown: string;
  claimStart: string;
  claimWarning: string;
  claimCountdown: string;
  rakeNotice: string;
  claimExpiredEdit: string;
  claimExpired: string;
  settlingWait: string;
  cancelled: string;
  continuationPrompt: string;
  bankerDice: string;
  rewardCongrats: string;
}

export const DEFAULT_MESSAGE_TEMPLATES: MessageTemplates = {
  welcome:
    '欢迎进入【至尊牛牛】互动群\n\n这里不是旁观大厅，而是本局实时战场。\n请先完成实名与充值，凑齐人数后自动开局。\n准备好了，就留下做局。',
  bidStart:
    '【第 {{seqNo}} 局 · 庄家竞标开启】\n\n全员可上庄，现在开始叫价！\n竞标时长：{{bidSeconds}} 秒\n最低出价：RM {{minBid}}\n\n直接发送金额即可出价；再次发送=改价。\n有人出价后我会实时 @ 播报，欢迎继续加价。\n最高有效价锁定庄家。',
  bidPlaced:
    '叫价更新！\n{{player}} 出价 RM {{amount}}\n\n当前最高：{{leader}} · RM {{high}}\n还有没有更高？直接发金额，错过就没了！',
  bidClosing:
    '【竞标截止 · 最终确认】\n\n本局出价名单：\n{{bidList}}\n\n当前最高：{{leader}} · RM {{high}}\n下面开始 3、2、1 倒计时，倒计时结束立刻锁定庄家！',
  bidCountdownStart: '【竞标即将锁定】\n出价时间到，开始 3、2、1 最终确认！',
  bidCountdown3: '3',
  bidCountdown2: '2',
  bidCountdown1: '1',
  bidFinalList:
    '【竞标结束 · 最终名单】\n\n本局出价名单：\n{{bidList}}\n\n当前最高出价：{{leader}} · RM {{high}}\n锁庄前将复核资格与余额；如未通过，顺延下一位。',
  bankerSelected:
    '【庄家锁定】\n恭喜 {{banker}} 拿下第 {{seqNo}} 局庄家！\n本局庄钱：RM {{pot}}\n\n庄钱已冻结入池，闲家准备开注。',
  betStart:
    '【第 {{seqNo}} 局 · 开注】\n\n本局庄家：{{banker}}\n庄钱：RM {{pot}}\n下注时长：{{betSeconds}} 秒\n\n普通下注：RM {{betMin}} ~ {{betMax}}\n梭哈范围：RM {{shMin}} ~ {{shMax}}\n\n操作说明：\n· 发送金额 = 下注\n· 发送 sh金额 = 梭哈（如 sh200）\n· 发送 0 = 撤回本局下注\n\n时间一到立刻封盘，请抓紧出手。',
  sealed:
    '【封盘 · 等待发包】\n下注已截止。\n请各位留在本页，勿退出，以免错过抢包。\n小助手正在准备本局红包…',
  sealedSummary:
    '【停止下注 · 封盘明细】\n\n庄家：{{banker}}\n庄钱：RM {{pot}}\n发包金额：RM {{packetTotal}}\n发包数量：{{packetCount}} 个\n总下注：RM {{betTotal}}\n总梭哈：RM {{shTotal}}\n\n代包手1：{{tailPackerBanker}}（庄家尾包）\n代包手2：{{tailPackerPlayer}}（闲家尾包）\n\n本局下注成功名单：\n{{betList}}',
  dicePrompt:
    '【庄家投骰】\n请庄家 {{banker}} 在 60 秒内投出 3 颗骰子。\n投骰后进入发包与抢包流程。\n如需重开本局，可发送 /重推。',
  betCountdown: '下注倒计时 · 还剩 {{remaining}} 秒\n未出手的抓紧了，时间到立刻封盘！',
  claimStart:
    '【红包已发出 · 开始抢包】\n仅本局庄家与已下注闲家可领。\n倒计时 {{claimSeconds}} 秒，过期无法再领。\n点开红包立刻抢，手慢无！',
  claimWarning:
    '【领包提醒 · {{claimSeconds}} 秒】\n请尽快领取本局红包。\n超时未领将按尾包规则由系统补录，结果不得争议。\n恶意卡包、拖延认额，将按平台规则处理。',
  claimCountdown:
    '抢包进行中 · 还剩 {{remaining}} 秒\n仅本局庄家与已下注闲家可领，过期即止。',
  claimExpiredEdit: '【抢包结束】\n红包已过期，正在核对领取明细，请稍候成绩单。',
  claimExpired: '【抢包结束】\n领取通道已关闭。平台正在核对明细并统算，成绩单一会公布。',
  rakeNotice:
    '【抽水通告】\n闲家盈利抽 {{playerRake}}%，庄家盈利抽 {{bankerRake}}%。\n公平对局，祝各位老板发发发！',
  settlingWait: '【结算中】\n抢包已结束，正在统算牌型与输赢…\n请稍候，成绩单马上公布。',
  cancelled:
    '【第 {{seqNo}} 局已取消】\n原因：{{reason}}\n本局冻结金额已全部原路退回，不影响下一局。',
  continuationPrompt:
    '【续庄询问】\n本局庄家 {{banker}}，还要继续坐庄吗？\n请在 {{window}} 秒内点击「续庄确认」。\n\n续庄规则：\n· 沿用庄钱 RM {{pot}}\n· 跳过竞标，直接开注\n· 每次竞标中标后最多续庄一次（连续最多两局）\n· 第三局必须重新竞标，原庄仍可参与并再次中标',
  bankerDice: '【庄家开骰】\n庄家：{{banker}}\n点数：{{dice}}\n牌型据此开算，请各位看结果。',
  rewardCongrats: '【奖励到账】\n恭喜 {{player}} 获得「{{title}}」\n奖励金额：RM {{amount}}\n已发放至余额，可在钱包查看。',
};

const LEGACY_BID_FINAL_LIST =
  '【竞标结束 · 最终名单】\n\n本局出价名单：\n{{bidList}}\n\n最高有效出价：{{leader}} · RM {{high}}';

function defaultMessageTemplates(gameCode: string): MessageTemplates {
  const game = GAME_CATALOG[gameCode as SupportedGameCode];
  if (!game || gameCode === SUPREME_NIUNIU_GAME_CODE) {
    return DEFAULT_MESSAGE_TEMPLATES;
  }
  return {
    ...DEFAULT_MESSAGE_TEMPLATES,
    welcome: DEFAULT_MESSAGE_TEMPLATES.welcome.replace('至尊牛牛', game.title),
  };
}

export async function getMessageTemplates(
  gameCode: string,
): Promise<MessageTemplates> {
  return getGameConfig(
    gameCode,
    'messages',
    defaultMessageTemplates(gameCode),
  );
}

export async function getMessageTemplatesForRoom(
  roomId: string,
): Promise<MessageTemplates> {
  return getMessageTemplates(await gameCodeForRoom(roomId));
}

export function renderMessage(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
    String(vars[key] ?? ''),
  );
}

export interface GameSettings {
  hand: HandConfig;
  betting: BettingConfig;
  fees: FeeConfig;
  rebate: RebateConfig;
  round: RoundConfig;
  rewards: RewardRules;
}

export async function getGameSettings(gameCode: string): Promise<GameSettings> {
  const [hand, betting, fees, rebate, round, rewards] = await Promise.all([
    getGameConfig(gameCode, 'hand', DEFAULT_HAND_CONFIG),
    getGameConfig(gameCode, 'betting', DEFAULT_BETTING_CONFIG),
    getGameConfig(gameCode, 'fees', DEFAULT_FEE_CONFIG),
    getGameConfig(gameCode, 'rebate', DEFAULT_REBATE_CONFIG),
    getGameConfig(gameCode, 'round', DEFAULT_ROUND_CONFIG),
    getGameConfig(gameCode, 'rewards', DEFAULT_REWARD_RULES),
  ]);
  return { hand, betting, fees, rebate, round, rewards };
}

export async function getGameSettingsForRoom(
  roomId: string,
): Promise<GameSettings> {
  return getGameSettings(await gameCodeForRoom(roomId));
}

/**
 * 调整小助手服务。关闭小助手时强制关闭自动开局。
 * 不影响互动群入口 ACTIVE/PAUSED。
 */
export async function setAssistantService(
  gameCode: string,
  patch: { assistantEnabled?: boolean; autoStart?: boolean },
  updatedBy?: string,
) {
  const current = await getGameConfig(
    gameCode,
    'round',
    DEFAULT_ROUND_CONFIG,
  );
  const assistantEnabled =
    patch.assistantEnabled !== undefined ? patch.assistantEnabled : current.assistantEnabled !== false;
  let autoStart = patch.autoStart !== undefined ? patch.autoStart : Boolean(current.autoStart);
  if (!assistantEnabled) autoStart = false;
  const next = { ...current, assistantEnabled, autoStart };
  await setGameConfig(gameCode, 'round', next, updatedBy);
  const rooms = await prisma.room.findMany({
    where: { gameCode },
    select: { id: true },
  });
  for (const room of rooms) {
    assistantGateByRoom.set(room.id, {
      enabled: assistantEnabled,
      expiresAt: Date.now() + 10_000,
    });
  }
  return next;
}

/** @deprecated 使用 setAssistantService */
export async function setRoundAutoStart(
  gameCode: string,
  autoStart: boolean,
  updatedBy?: string,
) {
  return setAssistantService(gameCode, { autoStart }, updatedBy);
}

export async function ensureGameConfigDefaults(): Promise<void> {
  for (const gameCode of SUPPORTED_GAME_CODES) {
    const defaults: Record<GameConfigKey, object> = {
      hand: DEFAULT_HAND_CONFIG,
      betting: DEFAULT_BETTING_CONFIG,
      fees: DEFAULT_FEE_CONFIG,
      rebate: DEFAULT_REBATE_CONFIG,
      round: DEFAULT_ROUND_CONFIG,
      rewards: DEFAULT_REWARD_RULES,
      leaderboard: {
        topN: 100,
        maskNames: true,
        pointsMetric: 'turnover',
        enabledTypes: ['points', 'hands', 'banker'],
        labels: {
          points: '积分榜',
          hands: '牌型榜',
          banker: '打桩榜',
        },
      },
      messages: defaultMessageTemplates(gameCode),
    };
    await Promise.all(
      Object.entries(defaults).map(async ([key, value]) => {
        const existing = await prisma.gameConfig.findUnique({
          where: { gameCode_key: { gameCode, key } },
        });
        let merged = deepMerge(value, existing?.value) as Record<string, unknown>;
        // 首次引入 assistantEnabled：默认关掉自动开局，避免一开入口就空转。
        if (key === 'round') {
          const raw = existing?.value as Record<string, unknown> | null;
          if (raw && typeof raw.assistantEnabled === 'undefined') {
            merged = { ...merged, assistantEnabled: true, autoStart: false };
          }
        }
        if (key === 'messages') {
          const raw = existing?.value as Record<string, unknown> | null;
          if (raw?.bidFinalList === LEGACY_BID_FINAL_LIST) {
            merged = {
              ...merged,
              bidFinalList: DEFAULT_MESSAGE_TEMPLATES.bidFinalList,
            };
          }
        }
        return prisma.gameConfig.upsert({
          where: { gameCode_key: { gameCode, key } },
          create: {
            gameCode,
            key,
            value: JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue,
            updatedBy: 'SYSTEM',
          },
          update: {
            value: JSON.parse(JSON.stringify(merged)) as Prisma.InputJsonValue,
          },
        });
      }),
    );
  }
  const rooms = await prisma.room.findMany({
    where: { gameCode: { in: SUPPORTED_GAME_CODES } },
    select: { id: true },
  });
  await Promise.all(
    rooms.map((room) => refreshAssistantGate(room.id)),
  );
}

export function settingsSnapshot(settings: GameSettings): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(settings)) as Prisma.InputJsonValue;
}

export function parseSettingsSnapshot(value: Prisma.JsonValue | null): GameSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ROUND_CONFIG_SNAPSHOT_MISSING');
  }
  const raw = value as unknown as Partial<GameSettings>;
  return {
    hand: {
      ...DEFAULT_HAND_CONFIG,
      ...raw.hand,
      multipliers: { ...DEFAULT_HAND_CONFIG.multipliers, ...raw.hand?.multipliers },
      normalMultipliers: {
        ...DEFAULT_HAND_CONFIG.normalMultipliers,
        ...raw.hand?.normalMultipliers,
      },
    },
    betting: { ...DEFAULT_BETTING_CONFIG, ...raw.betting },
    fees: { ...DEFAULT_FEE_CONFIG, ...raw.fees },
    rebate: { ...DEFAULT_REBATE_CONFIG, ...raw.rebate },
    round: { ...DEFAULT_ROUND_CONFIG, ...raw.round },
    rewards: { ...DEFAULT_REWARD_RULES, ...raw.rewards },
  };
}

const configSchemas = {
  hand: z
    .object({
      multipliers: z.record(z.number().int().min(1).max(100)).optional(),
      normalMultipliers: z.record(z.number().int().min(1).max(100)).optional(),
      bustThreshold: z.number().int().min(0).max(10).optional(),
      bustExemptSpecialHands: z.boolean().optional(),
    })
    .strict(),
  betting: z
    .object({
      betMinCents: z.number().int().min(1).max(100_000_000).optional(),
      shMinCents: z.number().int().min(1).max(100_000_000).optional(),
      betRatio: z.number().positive().max(1).optional(),
      shRatio: z.number().positive().max(1).optional(),
      playerCoefTiers: z
        .array(
          z.object({
            maxPlayers: z.number().int().min(1).max(100_000),
            coef: z.number().positive().max(100),
          }),
        )
        .min(1)
        .max(20)
        .optional(),
    })
    .strict(),
  fees: z
    .object({
      bankerSeatFeeRatio: z.number().min(0).max(1).optional(),
      serviceFeeCents: z.number().int().min(0).max(100_000_000).optional(),
      packetPerHeadCents: z.number().int().min(1).max(1_000_000).optional(),
      rakeRatio: z.number().min(0).max(1).optional(),
    })
    .strict(),
  rebate: z
    .object({
      selfRate: z.number().min(0).max(0.1).optional(),
      l1Rate: z.number().min(0).max(0.1).optional(),
      l2Rate: z.number().min(0).max(0.1).optional(),
      includeTieBets: z.boolean().optional(),
    })
    .strict(),
  round: z
    .object({
      bidDurationSeconds: z.number().int().min(5).max(3_600).optional(),
      betDurationSeconds: z.number().int().min(5).max(3_600).optional(),
      claimDurationSeconds: z.number().int().min(5).max(3_600).optional(),
      continuationWindowSeconds: z.number().int().min(5).max(300).optional(),
      bankerBidMinCents: z.number().int().min(1).max(1_000_000_000).optional(),
      bankerBidMaxCents: z.number().int().min(1).max(10_000_000_000).optional(),
      trendLength: z.number().int().min(1).max(100).optional(),
      assistantEnabled: z.boolean().optional(),
      autoStart: z.boolean().optional(),
      autoTailPacketEnabled: z.boolean().optional(),
      autoPublishPacketEnabled: z.boolean().optional(),
      tailPackerBankerName: z.string().min(1).max(80).optional(),
      tailPackerPlayerName: z.string().min(1).max(80).optional(),
    })
    .strict(),
  rewards: z
    .object({
      minBetCents: z.number().int().min(1).max(100_000_000).optional(),
      minAllInCents: z.number().int().min(1).max(100_000_000).optional(),
      bankerInstantAmountCents: z.number().int().min(1).max(1_000_000).optional(),
    })
    .strict(),
  leaderboard: z
    .object({
      topN: z.number().int().min(1).max(500).optional(),
      maskNames: z.boolean().optional(),
      pointsMetric: z.literal('turnover').optional(),
      enabledTypes: z
        .array(z.enum(['points', 'hands', 'banker']))
        .min(1)
        .max(3)
        .optional(),
      labels: z
        .object({
          points: z.string().min(1).max(30).optional(),
          hands: z.string().min(1).max(30).optional(),
          banker: z.string().min(1).max(30).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  messages: z
    .object({
      welcome: z.string().min(1).max(4_000).optional(),
      bidStart: z.string().min(1).max(4_000).optional(),
      bidPlaced: z.string().min(1).max(4_000).optional(),
      bidClosing: z.string().min(1).max(8_000).optional(),
      bidCountdownStart: z.string().min(1).max(4_000).optional(),
      bidCountdown3: z.string().min(1).max(200).optional(),
      bidCountdown2: z.string().min(1).max(200).optional(),
      bidCountdown1: z.string().min(1).max(200).optional(),
      bidFinalList: z.string().min(1).max(8_000).optional(),
      bankerSelected: z.string().min(1).max(4_000).optional(),
      betStart: z.string().min(1).max(4_000).optional(),
      sealed: z.string().min(1).max(4_000).optional(),
      sealedSummary: z.string().min(1).max(8_000).optional(),
      dicePrompt: z.string().min(1).max(4_000).optional(),
      betCountdown: z.string().min(1).max(4_000).optional(),
      claimStart: z.string().min(1).max(4_000).optional(),
      claimWarning: z.string().min(1).max(4_000).optional(),
      claimCountdown: z.string().min(1).max(4_000).optional(),
      rakeNotice: z.string().min(1).max(4_000).optional(),
      claimExpiredEdit: z.string().min(1).max(4_000).optional(),
      claimExpired: z.string().min(1).max(4_000).optional(),
      settlingWait: z.string().min(1).max(4_000).optional(),
      cancelled: z.string().min(1).max(4_000).optional(),
      continuationPrompt: z.string().min(1).max(4_000).optional(),
      bankerDice: z.string().min(1).max(4_000).optional(),
      rewardCongrats: z.string().min(1).max(4_000).optional(),
    })
    .strict(),
} as const;

export type GameConfigKey = keyof typeof configSchemas;

export function validateGameConfig(key: GameConfigKey, value: unknown): object {
  return configSchemas[key].parse(value);
}

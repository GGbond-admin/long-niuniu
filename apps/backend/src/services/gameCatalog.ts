/**
 * 游戏目录是创建互动群的唯一入口。
 *
 * 领域约束：一款游戏只有一个互动群；互动群不是同一游戏下可随意复制的牌桌。
 * 新增目录项前必须先接入对应规则引擎、配置命名空间和结算实现。
 */
import { prisma } from '../lib/prisma.js';
import { VALID_ROUND_PHASE_WHERE } from './adminRounds.js';
import { ensureWaitingRound } from './game.js';

export const SUPREME_NIUNIU_GAME_CODE = 'SUPREME_NIUNIU';

export const GAME_CATALOG = {
  [SUPREME_NIUNIU_GAME_CODE]: {
    code: SUPREME_NIUNIU_GAME_CODE,
    title: '至尊牛牛',
    interactionGroupTitle: '至尊牛牛互动群',
    engine: 'NIUNIU',
    rulesNamespace: 'supreme-niuniu',
    poolCodePrefix: 'ZZNN',
  },
} as const;

export type SupportedGameCode = keyof typeof GAME_CATALOG;

export const SUPPORTED_GAME_CODES = Object.keys(GAME_CATALOG) as SupportedGameCode[];

export function isSupportedGameCode(code: string): code is SupportedGameCode {
  return Object.prototype.hasOwnProperty.call(GAME_CATALOG, code);
}

export function gameDefinition(code: string) {
  return isSupportedGameCode(code) ? GAME_CATALOG[code] : null;
}

/** 利润池批号前缀，与后台房间/游戏一一对应；未入库游戏回退 TB。 */
export function profitPoolCodePrefix(gameCode: string): string {
  return gameDefinition(gameCode)?.poolCodePrefix ?? 'TB';
}

/** 为目录中的每款游戏确保唯一互动群存在；不会为同一游戏复制第二张牌桌。 */
export async function ensureCatalogInteractionGroups() {
  for (const code of SUPPORTED_GAME_CODES) {
    const game = GAME_CATALOG[code];
    const existing = await prisma.room.findUnique({
      where: { gameCode: code },
      select: { id: true, title: true },
    });
    if (existing) {
      if (existing.title !== game.title) {
        await prisma.room.update({
          where: { id: existing.id },
          data: { title: game.title },
        });
      }
      await ensureWaitingRound(existing.id);
      continue;
    }
    const created = await prisma.room.create({
      data: {
        gameCode: code,
        title: game.title,
        minPlayers: 2,
        status: 'ACTIVE',
      },
    });
    await ensureWaitingRound(created.id);
    console.log(`[game-catalog] initialized ${game.title} interaction group (${created.id})`);
  }
}

export async function listCatalogGames() {
  const rooms = await prisma.room.findMany({
    where: { gameCode: { in: SUPPORTED_GAME_CODES } },
    include: {
      _count: {
        select: {
          members: { where: { status: 'ACTIVE' } },
          rounds: { where: { phase: VALID_ROUND_PHASE_WHERE } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const roomByCode = new Map(rooms.map((room) => [room.gameCode, room]));
  return SUPPORTED_GAME_CODES.map((code) => {
    const game = GAME_CATALOG[code];
    const room = roomByCode.get(code) ?? null;
    return {
      ...game,
      room: room
        ? {
            id: room.id,
            title: game.title,
            status: room.status,
            minPlayers: room.minPlayers,
            roundStartMode: room.roundStartMode,
            chatMutedAt: room.chatMutedAt,
            chatMuteReason: room.chatMuteReason,
            members: room._count.members,
            rounds: room._count.rounds,
            createdAt: room.createdAt,
          }
        : null,
    };
  });
}

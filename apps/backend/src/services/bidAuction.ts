/**
 * 竞标拍卖播报：实时 @ 出价、3/2/1 数字倒计时、收官名单后锁定庄家。
 */
import { RoundPhase } from '@prisma/client';
import { fromCents } from '../engine/betting.js';
import { prisma } from '../lib/prisma.js';
import {
  BANKER_BID_INCREMENT_CENTS,
  closeBidding,
  GameError,
} from './game.js';
import { gameBus } from './gameBus.js';
import {
  getMessageTemplatesForRoom,
  renderMessage,
} from './gameSettings.js';
import {
  appendAssistantChatOnce,
  appendSystemChatOnce,
  rebroadcastRoomState,
  systemChat,
} from './roomHub.js';

const COUNTDOWN_GAP_MS = 1_000;
/** 收官倒计时默认数字（可被 messages.bidCountdown* 覆盖） */
const DEFAULT_LOCK_DIGITS = ['3', '2', '1'] as const;

type MentionUser = {
  uid: string;
  nickname?: string | null;
  tgUsername?: string | null;
};

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatBidAmount(cents: bigint): string {
  return fromCents(cents);
}

export function mentionUser(user: MentionUser): string {
  // 群内 @ 优先显示玩家昵称，避免暴露 Telegram 用户名或 UID
  const name = user.nickname?.trim();
  if (name) return `@${name}`;
  if (user.tgUsername) return `@${user.tgUsername}`;
  return `@UID${user.uid}`;
}

async function loadBids(roundId: string) {
  return prisma.bankerBid.findMany({
    where: { roundId },
    include: {
      user: { select: { uid: true, nickname: true, tgUsername: true } },
    },
    orderBy: [{ amountCents: 'desc' }, { createdAt: 'asc' }],
  });
}

function formatBidList(
  bids: Array<{ amountCents: bigint; user: MentionUser }>,
): string {
  if (!bids.length) return '（暂无出价）';
  return bids
    .map((bid, index) => {
      const mark = index === 0 ? ' ← 当前最高（锁庄前复核资格）' : '';
      return `${index + 1}. ${mentionUser(bid.user)} ${formatBidAmount(bid.amountCents)}${mark}`;
    })
    .join('\n');
}

/** 有人出价后：@ 播报金额并追问是否有更高；若触发防狙击延时则一并播报 */
export async function announceBidPlaced(params: {
  roundId: string;
  roomId: string;
  userId: string;
  amountCents: bigint;
  /** placeBankerBid 在最后 5 秒内出现新高价时返回的新截止时间 */
  extendedEndsAt?: Date | null;
}): Promise<void> {
  const [templates, bidder, bids] = await Promise.all([
    getMessageTemplatesForRoom(params.roomId),
    prisma.user.findUnique({
      where: { id: params.userId },
      select: { uid: true, nickname: true, tgUsername: true },
    }),
    loadBids(params.roundId),
  ]);
  if (!bidder) return;
  const leader = bids[0];
  const highCents = leader?.amountCents ?? params.amountCents;
  let content = stripHtml(
    renderMessage(templates.bidPlaced, {
      player: mentionUser(bidder),
      amount: formatBidAmount(params.amountCents),
      leader: leader ? mentionUser(leader.user) : mentionUser(bidder),
      high: formatBidAmount(highCents),
      next: formatBidAmount(highCents + BANKER_BID_INCREMENT_CENTS),
    }),
  );
  if (params.extendedEndsAt) {
    const seconds = Math.max(
      1,
      Math.round((params.extendedEndsAt.getTime() - Date.now()) / 1000),
    );
    const notice = `⏰最后时刻有人加价，倒计时重置为 ${seconds} 秒，还有更高的吗？`;
    content = content ? `${content}\n\n${notice}` : notice;
  }
  if (content) systemChat(params.roomId, content);
  if (params.extendedEndsAt) {
    // 立即重播房间状态，让前端倒计时同步跳回新的截止时间
    await rebroadcastRoomState({
      roomId: params.roomId,
      roundId: params.roundId,
      phase: RoundPhase.BANKER_BID,
    }).catch(() => undefined);
  }
}

type ClosingStep =
  | 'BID_CLOSING'
  | 'BID_COUNTDOWN_3'
  | 'BID_COUNTDOWN_2'
  | 'BID_COUNTDOWN_1'
  | 'BID_FINAL_LIST';

/**
 * 名义计时结束后推进收官仪式（3、2、1 播完前仍接受加价）：
 * 倒计时预告 → 依次各发一条 3 / 2 / 1 → 名单播报并封盘 → closeBidding。
 */
export async function advanceBidClosingCeremony(params: {
  roundId: string;
  roomId: string;
}): Promise<'pending' | 'closed'> {
  const round = await prisma.round.findUnique({
    where: { id: params.roundId },
    select: { id: true, roomId: true, phase: true, bidEndsAt: true },
  });
  if (!round || round.phase !== RoundPhase.BANKER_BID) return 'closed';
  if (!round.bidEndsAt || round.bidEndsAt > new Date()) return 'pending';

  const events = await prisma.roundEvent.findMany({
    where: {
      roundId: round.id,
      type: {
        in: [
          'BID_CLOSING',
          'BID_COUNTDOWN_3',
          'BID_COUNTDOWN_2',
          'BID_COUNTDOWN_1',
          'BID_FINAL_LIST',
        ],
      },
    },
    select: { type: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const byType = new Map(
    events.map((item) => [item.type as ClosingStep, item] as const),
  );
  const now = Date.now();
  const templates = await getMessageTemplatesForRoom(params.roomId);
  const digits = [
    stripHtml(templates.bidCountdown3) || DEFAULT_LOCK_DIGITS[0],
    stripHtml(templates.bidCountdown2) || DEFAULT_LOCK_DIGITS[1],
    stripHtml(templates.bidCountdown1) || DEFAULT_LOCK_DIGITS[2],
  ] as const;

  if (!byType.has('BID_CLOSING')) {
    const content = stripHtml(templates.bidCountdownStart);
    const sent = await appendSystemChatOnce(
      params.roomId,
      `round:${round.id}:bid:closing`,
      content || '⏰竞标倒数，3、2、1 播完前仍可继续加 100。',
    );
    if (!sent) return 'pending';
    await prisma.roundEvent.create({
      data: {
        roundId: round.id,
        type: 'BID_CLOSING',
        payload: { at: new Date().toISOString() },
      },
    });
    return 'pending';
  }

  const closingAt = byType.get('BID_CLOSING')!.createdAt.getTime();
  if (!byType.has('BID_COUNTDOWN_3') && now - closingAt >= COUNTDOWN_GAP_MS) {
    const sent = await appendAssistantChatOnce(
      params.roomId,
      `round:${round.id}:bid:countdown:3`,
      {
        type: 'COUNTDOWN',
        content: JSON.stringify({ mode: 'lock', emoji: digits[0] }),
      },
    );
    if (!sent) return 'pending';
    await prisma.roundEvent.create({
      data: {
        roundId: round.id,
        type: 'BID_COUNTDOWN_3',
        payload: { digit: digits[0] },
      },
    });
    return 'pending';
  }

  const t3 = byType.get('BID_COUNTDOWN_3');
  if (t3 && !byType.has('BID_COUNTDOWN_2') && now - t3.createdAt.getTime() >= COUNTDOWN_GAP_MS) {
    const sent = await appendAssistantChatOnce(
      params.roomId,
      `round:${round.id}:bid:countdown:2`,
      {
        type: 'COUNTDOWN',
        content: JSON.stringify({ mode: 'lock', emoji: digits[1] }),
      },
    );
    if (!sent) return 'pending';
    await prisma.roundEvent.create({
      data: {
        roundId: round.id,
        type: 'BID_COUNTDOWN_2',
        payload: { digit: digits[1] },
      },
    });
    return 'pending';
  }

  const t2 = byType.get('BID_COUNTDOWN_2');
  if (t2 && !byType.has('BID_COUNTDOWN_1') && now - t2.createdAt.getTime() >= COUNTDOWN_GAP_MS) {
    const sent = await appendAssistantChatOnce(
      params.roomId,
      `round:${round.id}:bid:countdown:1`,
      {
        type: 'COUNTDOWN',
        content: JSON.stringify({ mode: 'lock', emoji: digits[2] }),
      },
    );
    if (!sent) return 'pending';
    await prisma.roundEvent.create({
      data: {
        roundId: round.id,
        type: 'BID_COUNTDOWN_1',
        payload: { digit: digits[2] },
      },
    });
    return 'pending';
  }

  const t1 = byType.get('BID_COUNTDOWN_1');
  if (!t1 || now - t1.createdAt.getTime() < COUNTDOWN_GAP_MS) return 'pending';

  if (!byType.has('BID_FINAL_LIST')) {
    const bids = await loadBids(round.id);
    const leader = bids[0];
    const content = stripHtml(
      renderMessage(templates.bidFinalList, {
        bidList: formatBidList(bids),
        leader: leader ? mentionUser(leader.user) : '—',
        high: leader ? fromCents(leader.amountCents) : fromCents(0),
      }),
    );
    const sent = await appendSystemChatOnce(
      params.roomId,
      `round:${round.id}:bid:final-list`,
      content || '竞标结束，正在复核出价资格并锁定庄家。',
    );
    if (!sent) return 'pending';
    await prisma.roundEvent.create({
      data: {
        roundId: round.id,
        type: 'BID_FINAL_LIST',
        payload: { at: new Date().toISOString() },
      },
    });
    return 'pending';
  }

  const finalList = byType.get('BID_FINAL_LIST');
  if (!finalList || now - finalList.createdAt.getTime() < COUNTDOWN_GAP_MS) return 'pending';

  try {
    const result = await closeBidding(round.id);
    if (result.phase !== RoundPhase.BANKER_BID) {
      gameBus.transition({
        roundId: round.id,
        roomId: params.roomId,
        from: RoundPhase.BANKER_BID,
        to: result.phase,
      });
    }
    return 'closed';
  } catch (error) {
    if (
      error instanceof GameError &&
      ['INVALID_PHASE', 'ROUND_NOT_FOUND'].includes(error.code)
    ) {
      return 'closed';
    }
    throw error;
  }
}

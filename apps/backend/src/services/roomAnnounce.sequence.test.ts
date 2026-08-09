import { RoundPhase } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const settings = {
    betting: {},
    fees: { rakeRatio: 0.05 },
    round: {
      bidDurationSeconds: 30,
      betDurationSeconds: 50,
      claimDurationSeconds: 30,
      tailPackerBankerName: '庄家尾包',
      tailPackerPlayerName: '闲家尾包',
    },
  };
  const round = {
    id: 'round-1',
    seqNo: 8,
    bankerId: 'banker-1',
    potCents: 500_000n,
    configSnapshot: settings,
    bidEndsAt: new Date('2026-08-07T07:00:30.000Z'),
    betEndsAt: new Date('2026-08-07T07:01:20.000Z'),
    claimEndsAt: new Date('2026-08-07T07:02:00.000Z'),
    room: { id: 'room-1', title: '测试房' },
    bets: [
      {
        amountCents: 800n,
        isAllIn: false,
        user: { uid: 'player-1', nickname: '闲家一', tgUsername: null },
      },
    ],
    packet: { totalCents: 208n, participantCount: 2 },
    scoreboard: null,
    continuationUsed: false,
  };
  const templates = {
    bidStart: 'bid-start',
    bankerSelected: 'banker-selected {{banker}} {{pot}}',
    betStart: 'bet-start {{banker}} {{pot}} {{betSeconds}}',
    betCountdown: 'bet-countdown {{remaining}}',
    sealedSummary: 'sealed-summary {{banker}} {{betList}}',
    dicePrompt: 'dice-prompt {{banker}}',
    sealed: 'sealed-wait',
    claimStart: 'claim-start {{claimSeconds}}',
    claimWarning: 'claim-warning {{claimSeconds}}',
    claimCountdown: 'claim-countdown {{remaining}}',
  };
  return { round, settings, templates };
});

vi.mock('../engine/betting.js', () => ({
  bettingRange: vi.fn(() => ({
    betMinCents: 200,
    betMaxCents: 2_500,
    shMinCents: 2_000,
    shMaxCents: 25_000,
  })),
  fromCents: (value: bigint | number) => (Number(value) / 100).toFixed(2),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    round: { findUnique: vi.fn(async () => fixture.round) },
    user: {
      findUnique: vi.fn(async () => ({
        uid: 'banker',
        nickname: '庄家',
        tgUsername: null,
      })),
    },
  },
}));

vi.mock('./gameSettings.js', () => ({
  getMessageTemplatesForRoom: vi.fn(async () => fixture.templates),
  parseSettingsSnapshot: (value: unknown) => value,
  renderMessage: (template: string, vars: Record<string, string | number>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(vars[key] ?? '')),
}));

import { buildRoundAnnounceMessages } from './roomAnnounce.js';

function shape(
  messages: Awaited<ReturnType<typeof buildRoundAnnounceMessages>>,
): string[] {
  return messages.map((message) => {
    if (message.kind === 'banner') return `banner:${message.banner}`;
    if (message.kind === 'countdown') return `countdown:${message.mode}`;
    return message.content.split(' ')[0] ?? '';
  });
}

describe('阶段机器人播报顺序', () => {
  it('锁庄文字先于开始下注横幅', async () => {
    const messages = await buildRoundAnnounceMessages({
      roundId: 'round-1',
      to: RoundPhase.BETTING,
    });

    expect(shape(messages)).toEqual([
      'banker-selected',
      'banner:bet-start',
      'bet-start',
      'countdown:bet',
    ]);
  });

  it('封盘时只提示投骰，等待发包留到开骰之后', async () => {
    const messages = await buildRoundAnnounceMessages({
      roundId: 'round-1',
      to: RoundPhase.SENDING_PACKET,
    });

    expect(shape(messages)).toEqual([
      'banner:bet-stop',
      'sealed-summary',
      'dice-prompt',
    ]);
  });
});

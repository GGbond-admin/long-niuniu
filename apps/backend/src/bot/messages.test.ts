import type { RoundScoreboard } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { formatScoreboard, SCOREBOARD_EMOJI } from './messages.js';

describe('成绩单文案', () => {
  it('用不同符号区分赢输平，并只展示抢、下、本局与累计金额', () => {
    const scoreboard = {
      seqNo: 85,
      playerLines: [
        {
          uid: '1001',
          nickname: '赢家',
          claimCents: '111',
          betCents: '800',
          outcome: 'PLAYER_WIN',
          netCents: '13192',
          handType: 'BAOZI',
          points: 10,
          shortfallCents: '0',
          balanceBeforeCents: '500111',
          balanceAfterCents: '513303',
        },
        {
          uid: '1002',
          nickname: '输家',
          claimCents: '22',
          betCents: '200',
          isAllIn: true,
          outcome: 'BANKER_WIN',
          netCents: '-2328',
          handType: 'DUIZI',
          points: 2,
          shortfallCents: '0',
          balanceBeforeCents: '500455',
          balanceAfterCents: '498127',
        },
        {
          uid: '1003',
          nickname: '平家',
          claimCents: '280',
          betCents: '1000',
          outcome: 'TIE',
          netCents: '0',
          handType: 'NIUNIU',
          points: 10,
          shortfallCents: '0',
          balanceBeforeCents: '300000',
          balanceAfterCents: '300000',
        },
      ],
      bankerSummary: {
        uid: '2001',
        nickname: '庄家',
        claimCents: '70',
        netCents: '-5000',
        balanceBeforeCents: '100000',
        balanceAfterCents: '95000',
        trend: ['3点', '5点', '4点', '对子'],
      },
    } as unknown as RoundScoreboard;

    const text = formatScoreboard(scoreboard).join('\n');

    expect(text).toContain(
      `${SCOREBOARD_EMOJI.win} <b>@赢家</b> ·\n抢 1.11 · 下 8.00 · 赢→131.92`,
    );
    expect(text).toContain(
      '上局 5001.11 · 本局 5133.03',
    );
    expect(text).toContain(
      `${SCOREBOARD_EMOJI.lose} <b>@输家</b> ·\n抢 0.22 · 梭哈 2.00 · 输→23.28`,
    );
    expect(text).toContain(
      '上局 5004.55 · 本局 4981.27',
    );
    expect(text).toContain(
      `${SCOREBOARD_EMOJI.tie} <b>@平家</b> ·\n抢 2.80 · 下 10.00 · 水→0.00`,
    );
    expect(text).toContain(
      `${SCOREBOARD_EMOJI.banker} <b>庄家 @庄家</b> ·\n抢 0.70 · 输→50.00`,
    );
    expect(text).not.toContain('积分：');
    expect(text).not.toContain('上庄费');
    expect(text).toMatch(
      /━━━━━━━━━━━━━━━━━━\n庄家走势\n3点 → 5点 → 4点 → 对子$/,
    );
  });

  it('只覆盖展示标题、名称、备注和页脚，金融数字仍取原成绩单', () => {
    const scoreboard = {
      seqNo: 9,
      playerLines: [
        {
          userId: 'player-1',
          uid: '1001',
          nickname: '原玩家名',
          claimCents: '111',
          betCents: '800',
          outcome: 'PLAYER_WIN',
          netCents: '13192',
          shortfallCents: '0',
          balanceBeforeCents: '500111',
          balanceAfterCents: '513303',
        },
      ],
      bankerSummary: {
        userId: 'banker-1',
        uid: '2001',
        nickname: '原庄家名',
        claimCents: '70',
        netCents: '-5000',
        balanceBeforeCents: '100000',
        balanceAfterCents: '95000',
        trend: ['7点', '对子'],
      },
    } as unknown as RoundScoreboard;

    const text = formatScoreboard(scoreboard, {
      title: '第 9 局人工复核成绩单',
      playerAliases: { 'player-1': '复核玩家' },
      playerNotes: { 'player-1': '昵称已更正' },
      bankerAlias: '复核庄家',
      bankerNote: '展示信息已核对',
      footer: '本次仅更正展示文字，不影响账务。',
    }).join('\n');

    expect(text).toContain('<b>第 9 局人工复核成绩单</b>');
    expect(text).toContain('<b>@复核玩家</b>');
    expect(text).toContain('备注：昵称已更正');
    expect(text).toContain('<b>庄家 @复核庄家</b>');
    expect(text).toContain('备注：展示信息已核对');
    expect(text).toContain('本次仅更正展示文字，不影响账务。');
    expect(text).toContain('抢 1.11 · 下 8.00 · 赢→131.92');
    expect(text).toContain('抢 0.70 · 输→50.00');
    expect(text).toMatch(
      /本次仅更正展示文字，不影响账务。\n━━━━━━━━━━━━━━━━━━\n庄家走势\n7点 → 对子$/,
    );
  });

  it('转义展示文本并按聊天消息上限稳定分段', () => {
    const playerLines = Array.from({ length: 70 }, (_value, index) => ({
      userId: `player-${index}`,
      uid: String(1_000 + index),
      nickname: `玩家${index}`,
      claimCents: '111',
      betCents: '800',
      outcome: 'PLAYER_WIN',
      netCents: '13192',
      shortfallCents: '0',
      balanceBeforeCents: '500111',
      balanceAfterCents: '513303',
    }));
    const scoreboard = {
      seqNo: 10,
      playerLines,
      bankerSummary: {
        userId: 'banker-1',
        uid: '2001',
        nickname: '庄家',
        claimCents: '70',
        netCents: '-5000',
        balanceBeforeCents: '100000',
        balanceAfterCents: '95000',
      },
    } as unknown as RoundScoreboard;

    const chunks = formatScoreboard(scoreboard, {
      title: '<script>复核</script>',
      playerNotes: Object.fromEntries(
        playerLines.map((line) => [line.userId, `第 ${line.userId} 行 <b>备注</b>`]),
      ),
      footer: '<img src=x> 仅展示',
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 3_900)).toBe(true);
    expect(chunks.join('\n')).toContain('&lt;script&gt;复核&lt;/script&gt;');
    expect(chunks.join('\n')).toContain('&lt;b&gt;备注&lt;/b&gt;');
    expect(chunks.join('\n')).not.toContain('<script>');
    expect(chunks.join('\n')).not.toContain('<img');
  });

  it('临近消息上限时不拆散庄家走势标题与内容', () => {
    const trendText = '5点 → 7点 → 9点 → 豹子 → 3点 → 对子';
    const scoreboard = {
      seqNo: 12,
      playerLines: [],
      bankerSummary: {
        uid: '2001',
        nickname: '庄家',
        claimCents: '70',
        netCents: '-5000',
        balanceBeforeCents: '100000',
        balanceAfterCents: '95000',
        trend: trendText.split(' → '),
      },
    } as unknown as RoundScoreboard;

    const chunks = formatScoreboard(scoreboard, {
      footer: '附'.repeat(1_270),
    });

    expect(chunks.some((chunk) => (
      chunk.includes(`━━━━━━━━━━━━━━━━━━\n庄家走势\n${trendText}`)
    ))).toBe(true);
    expect(chunks.every((chunk) => !chunk.endsWith('庄家走势'))).toBe(true);
  });

  it('忽略无效走势项，且没有有效走势时不添加空区域', () => {
    const scoreboard = {
      seqNo: 11,
      playerLines: [],
      bankerSummary: {
        uid: '2001',
        nickname: '庄家',
        claimCents: '70',
        netCents: '0',
        balanceBeforeCents: '100000',
        balanceAfterCents: '100000',
        trend: [{ invalid: true }, '', null],
      },
    } as unknown as RoundScoreboard;

    expect(formatScoreboard(scoreboard).join('\n')).not.toContain('庄家走势');
  });

  it('庄钱赔完后未获赔的赢家标记为喝水', () => {
    const scoreboard = {
      seqNo: 13,
      playerLines: [
        {
          uid: '1004',
          nickname: '喝水玩家',
          claimCents: '88',
          betCents: '500',
          outcome: 'PLAYER_WIN',
          netCents: '0',
          shortfallCents: '8500',
          balanceBeforeCents: '200000',
          balanceAfterCents: '200000',
        },
      ],
      bankerSummary: {
        uid: '2001',
        nickname: '庄家',
        claimCents: '70',
        netCents: '0',
        balanceBeforeCents: '100000',
        balanceAfterCents: '100000',
      },
    } as unknown as RoundScoreboard;

    const text = formatScoreboard(scoreboard).join('\n');
    expect(text).toContain(
      `${SCOREBOARD_EMOJI.win} <b>@喝水玩家</b> ·\n抢 0.88 · 下 5.00 · 赢→0.00（喝水 · 庄钱已赔完）`,
    );
    expect(text).toContain(`${SCOREBOARD_EMOJI.banker} <b>庄家 @庄家</b>`);
  });
});

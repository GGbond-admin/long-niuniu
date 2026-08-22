import { describe, expect, it } from 'vitest';
import {
  bankerTrendLabelFromSummary,
  compareScoreboardHandOrder,
  continueBankerTrend,
  settleRound,
} from './settlement.js';
import { toCents } from './betting.js';
import { DEFAULT_HAND_CONFIG, HandType } from './hand.js';

const handConfig = {
  ...DEFAULT_HAND_CONFIG,
  // 测试用普通点倍数：全部 1 倍，便于核对金额
  normalMultipliers: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1 },
};

describe('单局结算（06 文档 §6 / 04 文档 T01–T08）', () => {
  it('T01 闲赢：倍数12（对子）注10，庄池充足 → 闲净+116.4，抽水3.6（闲赢 3%），庄-120', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('3.42'), // 普通 9 点
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.22') }], // 对子 12x
      handConfig,
    });
    const pair = r.pairs[0];
    expect(pair.outcome).toBe('PLAYER_WIN');
    expect(pair.multiplier).toBe(12);
    expect(pair.payableCents).toBe(toCents('120'));
    expect(pair.paidCents).toBe(toCents('120'));
    expect(pair.rakeCents).toBe(toCents('3.6'));
    expect(pair.playerNetCents).toBe(toCents('116.4'));
    expect(pair.bankerNetCents).toBe(-toCents('120'));
    expect(r.bankerProfitCents).toBe(-toCents('120'));
    expect(r.bankerRakeCents).toBe(0);
  });

  it('T02 闲赢但庄池不足 → 实付=庄池，免赔>0', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('3.42'),
      potCents: toCents('80'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.22') }],
      handConfig,
    });
    const pair = r.pairs[0];
    expect(pair.paidCents).toBe(toCents('80'));
    expect(pair.shortfallCents).toBe(toCents('40'));
    expect(pair.rakeCents).toBe(toCents('2.4')); // 按实付抽（闲赢 3%）
    expect(pair.playerNetCents).toBe(toCents('77.6'));
  });

  it('庄钱不足按赔付顺序：牌型高者优先，赔到归零后其余喝水（下注与庄家赔付规则 四）', () => {
    // 故意乱序传入（D→C→B→A），验证结算不依赖入参顺序
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.02'), // 普通 2 点自爆 → 闲家全赢
      potCents: toCents('100000'),
      players: [
        { userId: 'D', betCents: toCents('5000'), claimCents: toCents('0.09') }, // 普通 9 点 1x
        { userId: 'C', betCents: toCents('2000'), claimCents: toCents('0.70') }, // 金牛 11x 7 点
        { userId: 'B', betCents: toCents('3000'), claimCents: toCents('0.90') }, // 金牛 11x 9 点
        { userId: 'A', betCents: toCents('3000'), claimCents: toCents('6.66') }, // 豹子 17x 8 点
      ],
      handConfig,
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));

    expect(byUser.get('A')!.paidCents).toBe(toCents('51000'));
    expect(byUser.get('A')!.shortfallCents).toBe(0);
    expect(byUser.get('B')!.paidCents).toBe(toCents('33000'));
    expect(byUser.get('B')!.shortfallCents).toBe(0);
    // C 应赔 22000，庄钱只剩 16000 → 全部给 C
    expect(byUser.get('C')!.payableCents).toBe(toCents('22000'));
    expect(byUser.get('C')!.paidCents).toBe(toCents('16000'));
    expect(byUser.get('C')!.shortfallCents).toBe(toCents('6000'));
    // 庄钱归零 → D 喝水
    expect(byUser.get('D')!.paidCents).toBe(0);
    expect(byUser.get('D')!.shortfallCents).toBe(toCents('5000'));
    expect(r.potRemainingCents).toBe(0);
    // 成绩单按玩家自己的牌型等级从高到低：豹子 → 金牛9点 → 金牛7点 → 普通9点
    expect(r.pairs.map((pair) => pair.userId)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('赔付顺序按牌型等级，不随后台倍数改动而变（金牛调到 20 倍仍排在豹子之后）', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.02'), // 普通 2 点自爆 → 闲家全赢
      potCents: toCents('100'), // 只够赔一位
      players: [
        { userId: 'jinniu', betCents: toCents('100'), claimCents: toCents('0.90') }, // 金牛
        { userId: 'baozi', betCents: toCents('100'), claimCents: toCents('1.11') }, // 豹子
      ],
      handConfig: {
        ...handConfig,
        multipliers: { ...handConfig.multipliers, [HandType.JINNIU]: 20 },
      },
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));
    expect(byUser.get('baozi')!.paidCents).toBe(toCents('100'));
    expect(byUser.get('jinniu')!.paidCents).toBe(0);
  });

  it('成绩单名字按牌型等级从高到低，同级再比点数', () => {
    const order = [
      { handType: 'NORMAL', points: 9, claimCents: 900 },
      { handType: 'DUIZI', points: 4, claimCents: 122 },
      { handType: 'BAOZI', points: 8, claimCents: 666 },
      { handType: 'JINNIU', points: 9, claimCents: 90 },
      { handType: 'JINNIU', points: 5, claimCents: 50 },
    ].sort(compareScoreboardHandOrder);
    expect(order.map((line) => line.handType)).toEqual([
      'BAOZI',
      'DUIZI',
      'JINNIU',
      'JINNIU',
      'NORMAL',
    ]);
    expect(order[2]?.points).toBe(9);
    expect(order[3]?.points).toBe(5);
  });

  it('庄家走势只续写该庄家自己的历史，同一庄家再次上庄时继续', () => {
    const bankerATrend = continueBankerTrend(['9点', '反顺', '对子'], '豹子', 10);
    const bankerBTrend = continueBankerTrend([], '5点', 10);

    expect(bankerATrend).toEqual([
      '9点',
      '反顺',
      '对子',
      '豹子',
    ]);
    expect(bankerBTrend).toEqual(['5点']);
    expect(continueBankerTrend(bankerATrend, '1点', 3)).toEqual([
      '对子',
      '豹子',
      '1点',
    ]);
  });

  it('从单局成绩单快照提取庄家走势标签', () => {
    expect(bankerTrendLabelFromSummary({ handType: 'NORMAL', points: 9 })).toBe('9点');
    expect(bankerTrendLabelFromSummary({ handType: 'NORMAL', points: 0 })).toBe('0点');
    expect(bankerTrendLabelFromSummary({ handType: 'BAOZI', points: 10 })).toBe('豹子');
    expect(bankerTrendLabelFromSummary({ handType: 'NORMAL', points: null })).toBeNull();
    expect(bankerTrendLabelFromSummary({ handType: 'NORMAL', points: 2.5 })).toBeNull();
    expect(bankerTrendLabelFromSummary({ handType: 'NORMAL', points: 99 })).toBeNull();
    expect(bankerTrendLabelFromSummary({ handType: 'UNKNOWN', points: 3 })).toBeNull();
    expect(bankerTrendLabelFromSummary(null)).toBeNull();
  });

  it('同倍数同点数：红包金额大者先赔（2.35 优先于 1.18）', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.02'), // 自爆
      potCents: toCents('100'), // 只够赔一位
      players: [
        { userId: 'small', betCents: toCents('10'), claimCents: toCents('1.18') }, // 牛牛 10x
        { userId: 'big', betCents: toCents('10'), claimCents: toCents('2.35') }, // 牛牛 10x
      ],
      handConfig,
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));
    expect(byUser.get('big')!.paidCents).toBe(toCents('100'));
    expect(byUser.get('small')!.paidCents).toBe(0);
  });

  it('对子后两位相同再比前位：9.22 先于 1.22 赔付', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.02'),
      potCents: toCents('120'),
      players: [
        { userId: 'low', betCents: toCents('10'), claimCents: toCents('1.22') },
        { userId: 'high', betCents: toCents('10'), claimCents: toCents('9.22') },
      ],
      handConfig,
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));
    expect(byUser.get('high')!.paidCents).toBe(toCents('120'));
    expect(byUser.get('low')!.paidCents).toBe(0);
  });

  it('对子先比后两位：0.22 先于 5.11 赔付', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.02'),
      potCents: toCents('120'), // 只够赔一位 12x
      players: [
        { userId: 'front', betCents: toCents('10'), claimCents: toCents('5.11') },
        { userId: 'tail', betCents: toCents('10'), claimCents: toCents('0.22') },
      ],
      handConfig,
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));
    expect(byUser.get('tail')!.paidCents).toBe(toCents('120'));
    expect(byUser.get('front')!.paidCents).toBe(0);
  });

  it('金牛只比中间位：0.90 先于 10.80 赔付（前后不算）', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.02'),
      potCents: toCents('110'),
      players: [
        { userId: 'amount', betCents: toCents('10'), claimCents: toCents('10.80') },
        { userId: 'middle', betCents: toCents('10'), claimCents: toCents('0.90') },
      ],
      handConfig,
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));
    expect(byUser.get('middle')!.paidCents).toBe(toCents('110'));
    expect(byUser.get('amount')!.paidCents).toBe(0);
  });

  it('倍数点数红包金额全同：下注时间早者先赔', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.02'),
      potCents: toCents('100'),
      players: [
        { userId: 'late', betCents: toCents('10'), claimCents: toCents('2.35'), betPlacedAtMs: 2_000 },
        { userId: 'early', betCents: toCents('10'), claimCents: toCents('2.35'), betPlacedAtMs: 1_000 },
      ],
      handConfig,
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));
    expect(byUser.get('early')!.paidCents).toBe(toCents('100'));
    expect(byUser.get('late')!.paidCents).toBe(0);
  });

  it('梭哈赢固定 1:1：豹子 17x 也只拿等额下注（普通下注与梭哈下注规则 二）', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.02'), // 庄家自爆
      potCents: toCents('10000'),
      players: [
        { userId: 'sh', betCents: toCents('100'), claimCents: toCents('1.11'), isAllIn: true },
        { userId: 'normal', betCents: toCents('100'), claimCents: toCents('1.11') },
      ],
      handConfig,
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));
    const sh = byUser.get('sh')!;
    expect(sh.multiplier).toBe(1);
    expect(sh.handMultiplier).toBe(17);
    expect(sh.payableCents).toBe(toCents('100'));
    expect(sh.paidCents).toBe(toCents('100'));
    expect(sh.rakeCents).toBe(toCents('3')); // 梭哈同样抽闲赢 3%
    expect(sh.playerNetCents).toBe(toCents('97'));
    // 同牌型的普通下注仍按 17 倍
    expect(byUser.get('normal')!.paidCents).toBe(toCents('1700'));
  });

  it('梭哈输固定 1 倍：庄家豹子也只从等额预留金扣走注额', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.11'), // 豹子 17x
      potCents: toCents('10000'),
      players: [
        {
          userId: 'sh',
          betCents: toCents('100'),
          claimCents: toCents('1.50'), // 普通 6 点
          reservedCents: toCents('100'), // 梭哈只需预留 1 倍
          isAllIn: true,
        },
      ],
      handConfig,
    });
    const pair = r.pairs[0];
    expect(pair.outcome).toBe('BANKER_WIN');
    expect(pair.multiplier).toBe(1);
    expect(pair.handMultiplier).toBe(17);
    expect(pair.payableCents).toBe(toCents('100'));
    expect(pair.paidCents).toBe(toCents('100'));
    expect(pair.shortfallCents).toBe(0);
    expect(pair.playerNetCents).toBe(-toCents('100'));
    expect(pair.rakeCents).toBe(0);
    expect(pair.bankerNetCents).toBe(toCents('100'));
    expect(r.bankerRakeCents).toBe(toCents('5'));
    expect(r.bankerGrossCents).toBe(toCents('95'));
  });

  it('庄钱不足：梭哈与普通同队排序，按各自牌型等级排（梭哈豹子先于普通牛牛）', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.02'),
      potCents: toCents('100'), // 只够赔梭哈那一位
      players: [
        { userId: 'normal', betCents: toCents('100'), claimCents: toCents('1.18') }, // 牛牛 10x
        { userId: 'sh', betCents: toCents('100'), claimCents: toCents('1.11'), isAllIn: true }, // 豹子 17x → 1:1
      ],
      handConfig,
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));
    expect(byUser.get('sh')!.paidCents).toBe(toCents('100'));
    expect(byUser.get('normal')!.paidCents).toBe(0);
    expect(byUser.get('normal')!.shortfallCents).toBe(toCents('1000'));
  });

  it('梭哈仍走免死与自爆判定，只是赔付额按 1 倍', () => {
    const mianSi = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.11'),
      potCents: toCents('10000'),
      players: [
        { userId: 'sh', betCents: toCents('100'), claimCents: toCents('0.01'), isAllIn: true },
      ],
      handConfig,
    });
    expect(mianSi.pairs[0]).toMatchObject({
      outcome: 'TIE',
      multiplier: 0,
      payableCents: 0,
      rakeCents: 0,
    });

    const bust = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.11'),
      potCents: toCents('10000'),
      players: [
        {
          userId: 'sh',
          betCents: toCents('100'),
          claimCents: toCents('0.03'), // 3 点自爆
          reservedCents: toCents('100'),
          isAllIn: true,
        },
      ],
      handConfig,
    });
    expect(bust.pairs[0]).toMatchObject({
      outcome: 'BANKER_WIN',
      isBustPlayer: true,
      multiplier: 1,
      paidCents: toCents('100'),
    });
  });

  it('抽水分侧：玩家赢 3%、庄家赢 5%，与利润池文档一致', () => {
    const playerWin = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.30'), // 普通 4 点（金额小 → 输）
      potCents: toCents('100000'),
      players: [{ userId: 'p1', betCents: toCents('1000'), claimCents: toCents('3.42') }], // 普通 9 点，1x
      handConfig,
    });
    expect(playerWin.pairs[0].outcome).toBe('PLAYER_WIN');
    // 玩家赢 RM1000 → 抽水 3% = RM30
    expect(playerWin.pairs[0].rakeCents).toBe(toCents('30'));

    const bankerWin = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('3.42'), // 普通 9 点，1x
      potCents: toCents('100000'),
      players: [
        {
          userId: 'p1',
          betCents: toCents('50000'),
          claimCents: toCents('1.30'), // 普通 4 点（金额小 → 输）
          reservedCents: toCents('50000'),
        },
      ],
      handConfig,
    });
    expect(bankerWin.pairs[0].outcome).toBe('BANKER_WIN');
    // 庄家赢 RM50000 → 抽水 5% = RM2500，记在局级 bankerRakeCents
    expect(bankerWin.pairs[0].rakeCents).toBe(0);
    expect(bankerWin.bankerRakeCents).toBe(toCents('2500'));
  });

  it('庄家抽水按本局对赌毛利：实收200实赔50 → 毛利150抽7.5，不是按赢的那笔200抽10', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('3.42'), // 普通 9 点
      potCents: toCents('100000'),
      players: [
        {
          userId: 'lose',
          betCents: toCents('200'),
          claimCents: toCents('1.30'), // 普通 4 点 → 庄赢
          reservedCents: toCents('200'),
        },
        {
          userId: 'win',
          betCents: toCents('50'),
          claimCents: toCents('5.40'), // 普通 9 点金额更大 → 闲赢
        },
      ],
      handConfig,
    });
    const byUser = new Map(r.pairs.map((pair) => [pair.userId, pair]));
    expect(byUser.get('lose')!.outcome).toBe('BANKER_WIN');
    expect(byUser.get('lose')!.paidCents).toBe(toCents('200'));
    expect(byUser.get('lose')!.rakeCents).toBe(0);
    expect(byUser.get('win')!.outcome).toBe('PLAYER_WIN');
    expect(byUser.get('win')!.paidCents).toBe(toCents('50'));
    expect(byUser.get('win')!.rakeCents).toBe(toCents('1.5'));
    expect(r.bankerProfitCents).toBe(toCents('150'));
    expect(r.bankerRakeCents).toBe(toCents('7.5'));
    expect(r.totalRakeCents).toBe(toCents('9'));
    expect(r.bankerGrossCents).toBe(toCents('142.5'));
  });

  it('本局庄家对赌亏损时不抽庄家水', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('3.42'),
      potCents: toCents('100000'),
      players: [
        {
          userId: 'lose',
          betCents: toCents('10'),
          claimCents: toCents('1.30'),
          reservedCents: toCents('10'),
        },
        { userId: 'win', betCents: toCents('100'), claimCents: toCents('5.40') },
      ],
      handConfig,
    });
    expect(r.bankerProfitCents).toBe(-toCents('90'));
    expect(r.bankerRakeCents).toBe(0);
  });

  it('T03 闲输按庄家（赢方）倍数：庄对子12x 注10 → 闲-120，庄净+114，抽水6', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.22'), // 对子 12x
      potCents: toCents('1000'),
      players: [
        {
          userId: 'p1',
          betCents: toCents('10'),
          claimCents: toCents('3.42'), // 普通9点
          reservedCents: toCents('170'),
        },
      ],
      handConfig,
    });
    const pair = r.pairs[0];
    expect(pair.outcome).toBe('BANKER_WIN');
    expect(pair.multiplier).toBe(12);
    expect(pair.payableCents).toBe(toCents('120'));
    expect(pair.paidCents).toBe(toCents('120'));
    expect(pair.playerNetCents).toBe(-toCents('120'));
    expect(pair.bankerNetCents).toBe(toCents('120'));
    expect(pair.rakeCents).toBe(0);
    expect(r.bankerRakeCents).toBe(toCents('6'));
    expect(r.bankerGrossCents).toBe(toCents('114'));
  });

  it('需求文档场景：庄家金牛11x 注3 → 闲家扣 3×11=33', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.50'), // 金牛 11x
      potCents: toCents('1000'),
      players: [
        {
          userId: 'p1',
          betCents: toCents('3'),
          claimCents: toCents('1.50'), // 普通6点
          reservedCents: toCents('51'),
        },
      ],
      handConfig,
    });
    const pair = r.pairs[0];
    expect(pair.outcome).toBe('BANKER_WIN');
    expect(pair.multiplier).toBe(11);
    expect(pair.payableCents).toBe(toCents('33'));
    expect(pair.paidCents).toBe(toCents('33'));
    expect(pair.playerNetCents).toBe(-toCents('33'));
    expect(pair.rakeCents).toBe(0);
    expect(pair.bankerNetCents).toBe(toCents('33'));
    expect(r.bankerRakeCents).toBe(toCents('1.65'));
    expect(r.bankerGrossCents).toBe(toCents('31.35'));
  });

  it('兼容旧单：预留金不足时按预留上限收取，差额防御性记免赔', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.50'), // 金牛 11x
      potCents: toCents('1000'),
      players: [
        {
          userId: 'p1',
          betCents: toCents('3'),
          claimCents: toCents('1.50'),
          reservedCents: toCents('13'), // 旧系统只冻结了部分赔付能力
        },
      ],
      handConfig,
    });
    const pair = r.pairs[0];
    expect(pair.payableCents).toBe(toCents('33'));
    expect(pair.paidCents).toBe(toCents('13'));
    expect(pair.shortfallCents).toBe(toCents('20'));
    expect(pair.playerNetCents).toBe(-toCents('13'));
    expect(pair.rakeCents).toBe(0);
    expect(r.bankerRakeCents).toBe(toCents('0.65'));
  });

  it('免死（0.01）：闲家抢到判和退本；庄家抢到全场判和', () => {
    // 闲家免死：即使对上强牌也判和
    const r1 = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.11'), // 豹子
      potCents: toCents('1000'),
      players: [
        { userId: 'p1', betCents: toCents('10'), claimCents: toCents('0.01'), reservedCents: toCents('170') },
      ],
      handConfig,
    });
    expect(r1.pairs[0].outcome).toBe('TIE');
    expect(r1.pairs[0].playerNetCents).toBe(0);
    expect(r1.pairs[0].rakeCents).toBe(0);

    // 庄家免死：所有对子判和
    const r2 = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.01'),
      potCents: toCents('1000'),
      players: [
        { userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.11') }, // 豹子
        { userId: 'p2', betCents: toCents('10'), claimCents: toCents('1.20') }, // 3点自爆牌
      ],
      handConfig,
    });
    expect(r2.pairs.every((pair) => pair.outcome === 'TIE')).toBe(true);
    expect(r2.bankerGrossCents).toBe(0);
    expect(r2.totalRakeCents).toBe(0);
  });

  it('T04 金额完全相同 → 庄赢（按庄家牌型倍数赔付）', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('2.80'), // 牛牛
      potCents: toCents('1000'),
      players: [
        { userId: 'p1', betCents: toCents('10'), claimCents: toCents('2.80'), reservedCents: toCents('170') },
      ],
      handConfig,
    });
    expect(r.pairs[0].outcome).toBe('BANKER_WIN');
    expect(r.pairs[0].handMultiplier).toBe(10); // 牛牛 10 倍
    expect(r.pairs[0].paidCents).toBe(toCents('100'));
    expect(r.stats.playerLose).toBe(1);
  });

  it('比较键相同再比整笔金额：庄金牛 0.50 输给闲金牛 10.50', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.50'),
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('10.50') }],
      handConfig,
    });
    expect(r.pairs[0].outcome).toBe('PLAYER_WIN');
  });

  it('特殊牌型永不自爆：闲满牛 1.00（1点）赢庄牛牛 0.19', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('0.19'), // 牛牛（10点）
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('53'), claimCents: toCents('1.00') }], // 满牛，点数 1
      handConfig,
    });
    expect(r.pairs[0].isBustPlayer).toBe(false);
    expect(r.pairs[0].outcome).toBe('PLAYER_WIN');
    expect(r.pairs[0].handMultiplier).toBe(15); // 满牛 15 倍
    expect(r.pairs[0].paidCents).toBe(toCents('795')); // 53 × 15
  });

  it('同点（10点）比金额：2.80 赢 1.09', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.09'),
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('2.80') }],
      handConfig,
    });
    expect(r.pairs[0].outcome).toBe('PLAYER_WIN');
  });

  it('闲家自爆（≤3点普通）直接输', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.30'), // 普通4点，不自爆
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.20') }], // 普通3点自爆
      handConfig,
    });
    expect(r.pairs[0].outcome).toBe('BANKER_WIN');
    expect(r.pairs[0].isBustPlayer).toBe(true);
  });

  it('庄家自爆 → 未自爆闲家全赢；双自爆 → 庄赢', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.20'), // 普通3点自爆
      potCents: toCents('1000'),
      players: [
        { userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.30') }, // 普通4点，不自爆
        { userId: 'p2', betCents: toCents('10'), claimCents: toCents('1.10') }, // 普通2点自爆
      ],
      handConfig,
    });
    expect(r.pairs[0].outcome).toBe('PLAYER_WIN');
    // 双自爆 → 庄赢（已确认）
    expect(r.pairs[1].outcome).toBe('BANKER_WIN');
    expect(r.pairs[1].isBustPlayer).toBe(true);
    expect(r.pairs[1].isBustBanker).toBe(true);
  });

  it('关闭自爆后低点按正常比牌，不再直接判输', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.10'), // 普通2点
      potCents: toCents('1000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('1.20') }], // 普通3点
      handConfig: { ...handConfig, bustEnabled: false },
    });
    expect(r.pairs[0].isBustPlayer).toBe(false);
    expect(r.pairs[0].isBustBanker).toBe(false);
    expect(r.pairs[0].outcome).toBe('PLAYER_WIN');
  });

  it('庄家费用：庄钱5000 → 上庄费50；服务费38；30人代包费31.2', () => {
    const players = Array.from({ length: 29 }, (_, i) => ({
      userId: `p${i}`,
      betCents: toCents('10'),
      claimCents: toCents('3.42'),
    }));
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.22'),
      potCents: toCents('5000'),
      players,
      participantCount: 30,
      handConfig,
    });
    expect(r.fees.seatFeeCents).toBe(toCents('50'));
    expect(r.fees.serviceFeeCents).toBe(toCents('38'));
    expect(r.fees.packetFeeCents).toBe(toCents('31.2'));
  });

  it('有人弃权后仍按已经创建并托管的红包总额收取代包费', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('3.42'),
      potCents: toCents('5000'),
      players: [{ userId: 'p1', betCents: toCents('10'), claimCents: toCents('3.42') }],
      participantCount: 2,
      packetFeeCents: toCents('3.12'),
      handConfig,
    });

    expect(r.fees.packetFeeCents).toBe(toCents('3.12'));
    expect(r.fees.totalCents).toBe(
      r.fees.seatFeeCents + r.fees.serviceFeeCents + toCents('3.12'),
    );
  });

  it('庄家净结果 = 盈亏 − 三费（成绩单口径）', () => {
    const r = settleRound({
      bankerUserId: 'banker',
      bankerClaimCents: toCents('1.22'), // 对子，庄赢
      potCents: toCents('5000'),
      players: [{ userId: 'p1', betCents: toCents('100'), claimCents: toCents('3.42') }],
      participantCount: 2,
      handConfig,
    });
    // 旧单未传预留额时按本金防御性结算：庄收 100 - 5 抽水 = 95；费用 = 50 + 38 + 2.08
    expect(r.bankerGrossCents).toBe(toCents('95'));
    expect(r.fees.totalCents).toBe(toCents('50') + toCents('38') + 2 * 104);
    expect(r.bankerNetCents).toBe(r.bankerGrossCents - r.fees.totalCents);
  });
});

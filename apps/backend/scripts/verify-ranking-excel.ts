/**
 * 全量校验脚本：用《至尊牛牛_完整排序_对子与普通点数完全分开.xlsx》导出的
 * 数据（scripts/fixtures/niuniu_ranking.json）逐行核对引擎的牌型分类与排序。
 * 运行：pnpm --filter backend exec tsx scripts/verify-ranking-excel.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HAND_LABEL,
  HandType,
  compareHandStrength,
  evaluateHand,
  handTypeOf,
  pointsOf,
} from '../src/engine/hand.js';

interface All999Row { rank: number; type: string; cents: number; note: string }
interface OrdinaryRow { rank: number; label: string; cents: number }
interface ByPointRow { label: string; rankInPoint: number; cents: number }
interface PairRow { rank: number; label: string; cents: number }

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'niuniu_ranking.json');
const data = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  all999: All999Row[];
  ordinary: OrdinaryRow[];
  byPoint: ByPointRow[];
  pairs: PairRow[];
};

let failures = 0;
function fail(msg: string) {
  failures += 1;
  console.log('  ✗', msg);
}

function excelLabel(cents: number): string {
  const type = handTypeOf(cents);
  if (type === HandType.MIANSI) return '免死';
  if (type === HandType.FANSHUN) return '倒顺';
  if (type === HandType.NIUNIU) return '牛牛/10点';
  if (type === HandType.NORMAL) return `${pointsOf(cents)}点`;
  return HAND_LABEL[type];
}

// 1) 全部999金额：逐行核对牌型/点数分类
console.log('== 1. 全部999金额：999 行牌型分类 ==');
let typeMismatch = 0;
for (const row of data.all999) {
  const got = excelLabel(row.cents);
  if (got !== row.type) {
    typeMismatch += 1;
    if (typeMismatch <= 20) fail(`rank ${row.rank} ${(row.cents / 100).toFixed(2)}：表=${row.type} 引擎=${got}`);
  }
}
console.log(typeMismatch === 0 ? '  ✓ 999/999 分类一致' : `  共 ${typeMismatch} 处分类不一致`);

// 2) 全部999金额：全局顺序。对子块按「对子排序」权威口径（尾两位优先），
//    表内对子块本身按金额排（与对子排序页冲突），这些行按对子排序页校验。
console.log('== 2. 全部999金额：全局排序（对子块按对子排序页校验） ==');
const pairCentsInOrder = data.pairs.map((row) => row.cents);
const nonPairRows = data.all999.filter((row) => row.type !== '对子' && row.type !== '免死');
let orderMismatch = 0;
for (let i = 0; i < nonPairRows.length - 1; i += 1) {
  const hi = nonPairRows[i]!;
  const lo = nonPairRows[i + 1]!;
  const diff = compareHandStrength(evaluateHand(hi.cents), evaluateHand(lo.cents));
  if (diff <= 0) {
    orderMismatch += 1;
    if (orderMismatch <= 20) {
      fail(`rank ${hi.rank}(${(hi.cents / 100).toFixed(2)} ${hi.type}) 应强于 rank ${lo.rank}(${(lo.cents / 100).toFixed(2)} ${lo.type})`);
    }
  }
}
console.log(orderMismatch === 0 ? `  ✓ 非对子 ${nonPairRows.length} 行全局顺序一致` : `  共 ${orderMismatch} 处顺序不一致`);

// 对子块与全局的衔接：最弱倒顺 > 最强对子；最弱对子 > 最强金牛
const weakestFanshun = data.all999.filter((row) => row.type === '倒顺').at(-1)!;
const strongestPair = pairCentsInOrder[0]!;
const weakestPair = pairCentsInOrder.at(-1)!;
const strongestJinniu = data.all999.find((row) => row.type === '金牛')!;
if (compareHandStrength(evaluateHand(weakestFanshun.cents), evaluateHand(strongestPair)) <= 0) {
  fail('最弱倒顺应强于最强对子');
} else if (compareHandStrength(evaluateHand(weakestPair), evaluateHand(strongestJinniu.cents)) <= 0) {
  fail('最弱对子应强于最强金牛');
} else {
  console.log('  ✓ 对子块上接倒顺、下压金牛');
}

// 3) 对子排序：81 行顺序
console.log('== 3. 对子排序：81 行 ==');
let pairMismatch = 0;
for (let i = 0; i < pairCentsInOrder.length; i += 1) {
  const cents = pairCentsInOrder[i]!;
  if (handTypeOf(cents) !== HandType.DUIZI) {
    pairMismatch += 1;
    fail(`${(cents / 100).toFixed(2)} 未判为对子`);
    continue;
  }
  if (i < pairCentsInOrder.length - 1) {
    const diff = compareHandStrength(evaluateHand(cents), evaluateHand(pairCentsInOrder[i + 1]!));
    if (diff <= 0) {
      pairMismatch += 1;
      fail(`对子排序第 ${i + 1} 名 ${(cents / 100).toFixed(2)} 应强于第 ${i + 2} 名`);
    }
  }
}
console.log(pairMismatch === 0 ? '  ✓ 81 行全部一致（尾两位优先，同尾比前位）' : `  共 ${pairMismatch} 处不一致`);

// 4) 点数金额排序：873 行普通点数顺序
console.log('== 4. 点数金额排序：873 行 ==');
let ordinaryMismatch = 0;
for (let i = 0; i < data.ordinary.length; i += 1) {
  const row = data.ordinary[i]!;
  if (excelLabel(row.cents) !== row.label) {
    ordinaryMismatch += 1;
    if (ordinaryMismatch <= 10) fail(`rank ${row.rank} ${(row.cents / 100).toFixed(2)}：表=${row.label} 引擎=${excelLabel(row.cents)}`);
    continue;
  }
  if (i < data.ordinary.length - 1) {
    const next = data.ordinary[i + 1]!;
    const diff = compareHandStrength(evaluateHand(row.cents), evaluateHand(next.cents));
    if (diff <= 0) {
      ordinaryMismatch += 1;
      if (ordinaryMismatch <= 10) fail(`rank ${row.rank} ${(row.cents / 100).toFixed(2)} 应强于 rank ${next.rank} ${(next.cents / 100).toFixed(2)}`);
    }
  }
}
console.log(ordinaryMismatch === 0 ? '  ✓ 873 行标签与顺序全部一致' : `  共 ${ordinaryMismatch} 处不一致`);

// 5) 各点位明细：点内排名
console.log('== 5. 各点位明细：873 行点内排名 ==');
let byPointMismatch = 0;
const grouped = new Map<string, ByPointRow[]>();
for (const row of data.byPoint) {
  const list = grouped.get(row.label) ?? [];
  list.push(row);
  grouped.set(row.label, list);
}
for (const [label, rows] of grouped) {
  const sorted = [...rows].sort((a, b) => a.rankInPoint - b.rankInPoint);
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i]!;
    if (excelLabel(row.cents) !== label) {
      byPointMismatch += 1;
      if (byPointMismatch <= 10) fail(`${label} 第 ${row.rankInPoint} 名 ${(row.cents / 100).toFixed(2)} 引擎判为 ${excelLabel(row.cents)}`);
      continue;
    }
    if (i < sorted.length - 1) {
      const diff = compareHandStrength(evaluateHand(row.cents), evaluateHand(sorted[i + 1]!.cents));
      if (diff <= 0) {
        byPointMismatch += 1;
        if (byPointMismatch <= 10) fail(`${label} 第 ${row.rankInPoint} 名应强于第 ${sorted[i + 1]!.rankInPoint} 名`);
      }
    }
  }
}
console.log(byPointMismatch === 0 ? '  ✓ 各点位明细全部一致' : `  共 ${byPointMismatch} 处不一致`);

// 6) 「特别牌型」表：每个牌型的成员与完整排序逐条核对
console.log('== 6. 特别牌型：成员与排序 ==');
const SPECIAL_SHEET: Array<[HandType, number[]]> = [
  [HandType.BAOZI, [999, 888, 777, 666, 555, 444, 333, 222, 111]],
  [HandType.MANNIU, [900, 800, 700, 600, 500, 400, 300, 200, 100]],
  [HandType.SHUNZI, [789, 678, 567, 456, 345, 234, 123, 12]],
  [HandType.FANSHUN, [987, 876, 765, 654, 543, 432, 321, 210, 98]],
  [HandType.JINNIU, [90, 80, 70, 60, 50, 40, 30, 20, 10]],
];
let specialMismatch = 0;
for (const [type, list] of SPECIAL_SHEET) {
  // 成员判定 + 表内从大到小的顺序
  for (let i = 0; i < list.length; i += 1) {
    const cents = list[i]!;
    if (handTypeOf(cents) !== type) {
      specialMismatch += 1;
      fail(`${(cents / 100).toFixed(2)} 应判为 ${HAND_LABEL[type]}，引擎判为 ${excelLabel(cents)}`);
      continue;
    }
    if (i < list.length - 1) {
      const diff = compareHandStrength(evaluateHand(cents), evaluateHand(list[i + 1]!));
      if (diff <= 0) {
        specialMismatch += 1;
        fail(`${HAND_LABEL[type]}：${(cents / 100).toFixed(2)} 应强于 ${(list[i + 1]! / 100).toFixed(2)}`);
      }
    }
  }
  // 引擎不能把表以外的金额判成该牌型
  for (let cents = 1; cents <= 999; cents += 1) {
    if (handTypeOf(cents) === type && !list.includes(cents)) {
      specialMismatch += 1;
      fail(`引擎把 ${(cents / 100).toFixed(2)} 判为 ${HAND_LABEL[type]}，但表中没有`);
    }
  }
}
if (handTypeOf(1) !== HandType.MIANSI) {
  specialMismatch += 1;
  fail('0.01 应判为免死');
}
console.log(specialMismatch === 0 ? '  ✓ 五类特别牌型成员、顺序与表逐条一致；0.01 免死' : `  共 ${specialMismatch} 处不一致`);

// 7) 「规则说明」表：点数算法（三位相加，=10 记牛牛，否则取个位）逐个金额核对
console.log('== 7. 规则说明：点数算法与普通点数顺序 ==');
let ruleMismatch = 0;
for (let cents = 2; cents <= 999; cents += 1) {
  const type = handTypeOf(cents);
  if (type !== HandType.NORMAL && type !== HandType.NIUNIU) continue;
  const digitSum = Math.floor(cents / 100) + (Math.floor(cents / 10) % 10) + (cents % 10);
  const expectNiuniu = digitSum === 10;
  if (expectNiuniu !== (type === HandType.NIUNIU)) {
    ruleMismatch += 1;
    fail(`${(cents / 100).toFixed(2)} 三位和=${digitSum}，牛牛判定不符`);
  } else if (!expectNiuniu && pointsOf(cents) !== digitSum % 10) {
    ruleMismatch += 1;
    fail(`${(cents / 100).toFixed(2)} 三位和=${digitSum}，点数应为 ${digitSum % 10}，引擎=${pointsOf(cents)}`);
  }
}
// 牛牛/10点 > 9点 > … > 0点：任取每档最强 vs 下一档最强
const bestNiuniu = evaluateHand(910);
const pointBest: number[] = [];
for (let p = 9; p >= 0; p -= 1) {
  let best = -1;
  for (let cents = 999; cents >= 2; cents -= 1) {
    if (handTypeOf(cents) === HandType.NORMAL && pointsOf(cents) === p) { best = cents; break; }
  }
  pointBest.push(best);
}
if (compareHandStrength(bestNiuniu, evaluateHand(pointBest[0]!)) <= 0) {
  ruleMismatch += 1;
  fail('牛牛应强于最强 9 点');
}
for (let i = 0; i < pointBest.length - 1; i += 1) {
  if (compareHandStrength(evaluateHand(pointBest[i]!), evaluateHand(pointBest[i + 1]!)) <= 0) {
    ruleMismatch += 1;
    fail(`${9 - i}点最强应强于 ${8 - i}点最强`);
  }
}
console.log(ruleMismatch === 0 ? '  ✓ 点数算法与「牛牛/10点 > 9点 > … > 0点」全部一致' : `  共 ${ruleMismatch} 处不一致`);

// 8) 覆盖性：0.01–9.99 每个金额都在表中出现且只出现一次
console.log('== 8. 覆盖性：0.01–9.99 ==');
const seen = new Map<number, number>();
for (const row of data.all999) seen.set(row.cents, (seen.get(row.cents) ?? 0) + 1);
let coverageIssues = 0;
for (let cents = 1; cents <= 999; cents += 1) {
  const count = seen.get(cents) ?? 0;
  if (count !== 1) {
    coverageIssues += 1;
    fail(`${(cents / 100).toFixed(2)} 在全部999中出现 ${count} 次`);
  }
}
console.log(coverageIssues === 0 ? '  ✓ 999 个金额全覆盖、无重复' : `  共 ${coverageIssues} 处覆盖问题`);

console.log();
if (failures === 0) {
  console.log('全部校验通过：引擎与整份排序表一致。');
} else {
  console.log(`共 ${failures} 处需要修复。`);
  process.exitCode = 1;
}

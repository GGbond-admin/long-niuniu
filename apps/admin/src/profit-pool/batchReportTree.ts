import type { BatchAgentSnapshot } from './types';

export function groupByParent(items: BatchAgentSnapshot[]) {
  const ids = new Set(items.map((item) => item.sourceAgentId));
  const byParent = new Map<string | null, BatchAgentSnapshot[]>();
  for (const item of items) {
    const parent =
      item.parentSourceAgentId && ids.has(item.parentSourceAgentId)
        ? item.parentSourceAgentId
        : null;
    const list = byParent.get(parent) ?? [];
    list.push(item);
    byParent.set(parent, list);
  }
  return byParent;
}

export function collectDescendants(
  byParent: Map<string | null, BatchAgentSnapshot[]>,
  sourceAgentId: string,
) {
  const result: BatchAgentSnapshot[] = [];
  const walk = (id: string) => {
    for (const child of byParent.get(id) ?? []) {
      result.push(child);
      walk(child.sourceAgentId);
    }
  };
  walk(sourceAgentId);
  return result;
}

function sumField(items: BatchAgentSnapshot[], key: keyof BatchAgentSnapshot) {
  return items.reduce((total, item) => total + BigInt(item[key] as string), 0n);
}

export type LevelRollup = {
  level: number;
  count: number;
  selfTurnoverCents: bigint;
  selfAmountCents: bigint;
  overrideAmountCents: bigint;
  amountCents: bigint;
};

export function rollupByLevel(items: BatchAgentSnapshot[]): LevelRollup[] {
  const map = new Map<number, LevelRollup>();
  for (const item of items) {
    const current = map.get(item.level) ?? {
      level: item.level,
      count: 0,
      selfTurnoverCents: 0n,
      selfAmountCents: 0n,
      overrideAmountCents: 0n,
      amountCents: 0n,
    };
    current.count += 1;
    current.selfTurnoverCents += BigInt(item.selfTurnoverCents);
    current.selfAmountCents += BigInt(item.selfAmountCents);
    current.overrideAmountCents += BigInt(item.overrideAmountCents);
    current.amountCents += BigInt(item.amountCents);
    map.set(item.level, current);
  }
  return [...map.values()].sort((a, b) => a.level - b.level);
}

export type ReportRow =
  | {
      kind: 'root';
      item: BatchAgentSnapshot;
      descendantCount: number;
      treeAmountCents: bigint;
    }
  | {
      kind: 'self';
      item: BatchAgentSnapshot;
    }
  | {
      kind: 'level';
      item: BatchAgentSnapshot;
      rollup: LevelRollup;
    };

export function visibleRows(
  byParent: Map<string | null, BatchAgentSnapshot[]>,
  expanded: Set<string>,
): ReportRow[] {
  const result: ReportRow[] = [];
  for (const item of byParent.get(null) ?? []) {
    const descendants = collectDescendants(byParent, item.sourceAgentId);
    const treeAmountCents = BigInt(item.amountCents) + sumField(descendants, 'amountCents');
    result.push({
      kind: 'root',
      item,
      descendantCount: descendants.length,
      treeAmountCents,
    });
    if (descendants.length === 0 || !expanded.has(item.sourceAgentId)) continue;
    result.push({ kind: 'self', item });
    for (const rollup of rollupByLevel(descendants)) {
      result.push({ kind: 'level', item, rollup });
    }
  }
  return result;
}

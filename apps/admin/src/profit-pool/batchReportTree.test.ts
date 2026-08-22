import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BatchAgentSnapshot } from './types';
import { groupByParent, visibleRows } from './batchReportTree';

function agent(
  partial: Pick<BatchAgentSnapshot, 'sourceAgentId' | 'parentSourceAgentId' | 'level' | 'amountCents'> &
    Partial<BatchAgentSnapshot>,
): BatchAgentSnapshot {
  return {
    id: partial.sourceAgentId,
    userId: partial.sourceAgentId,
    label: partial.label ?? partial.sourceAgentId,
    uid: partial.sourceAgentId,
    nickname: null,
    avatarUrl: null,
    statusSnapshot: 'ACTIVE',
    sharePointsSnapshot: 0,
    bucketBaseSnapshot: 130,
    directAgentCount: 0,
    teamAgentCount: 0,
    directPlayerCount: 0,
    teamPlayerCount: 0,
    selfTurnoverCents: '0',
    teamTurnoverCents: '0',
    contributionBp: 0,
    selfAmountCents: partial.selfAmountCents ?? '0',
    overrideAmountCents: partial.overrideAmountCents ?? '0',
    ...partial,
  };
}

test('第一层合计利润是整条线加总，展开后按层级汇总下线', () => {
  const items = [
    agent({ sourceAgentId: 'l1', parentSourceAgentId: null, level: 1, amountCents: '5000' }),
    agent({ sourceAgentId: 'l2a', parentSourceAgentId: 'l1', level: 2, amountCents: '15000' }),
    agent({ sourceAgentId: 'l2b', parentSourceAgentId: 'l1', level: 2, amountCents: '10000' }),
    agent({ sourceAgentId: 'l3a', parentSourceAgentId: 'l2a', level: 3, amountCents: '8000' }),
    agent({ sourceAgentId: 'l3b', parentSourceAgentId: 'l2a', level: 3, amountCents: '7000' }),
    agent({ sourceAgentId: 'l4', parentSourceAgentId: 'l3a', level: 4, amountCents: '5000' }),
    agent({ sourceAgentId: 'l5', parentSourceAgentId: 'l4', level: 5, amountCents: '5000' }),
    agent({ sourceAgentId: 'other', parentSourceAgentId: null, level: 1, amountCents: '0' }),
  ];
  const byParent = groupByParent(items);
  const collapsed = visibleRows(byParent, new Set());
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0]?.kind, 'root');
  if (collapsed[0]?.kind === 'root') {
    assert.equal(collapsed[0].treeAmountCents, 55000n);
    assert.equal(collapsed[0].descendantCount, 6);
  }

  const expanded = visibleRows(byParent, new Set(['l1']));
  assert.deepEqual(
    expanded.map((row) => {
      if (row.kind === 'root') return ['root', String(row.treeAmountCents)];
      if (row.kind === 'self') return ['self', row.item.amountCents];
      return [`L${row.rollup.level}`, String(row.rollup.amountCents), row.rollup.count];
    }),
    [
      ['root', '55000'],
      ['self', '5000'],
      ['L2', '25000', 2],
      ['L3', '15000', 2],
      ['L4', '5000', 1],
      ['L5', '5000', 1],
      ['root', '0'],
    ],
  );
});

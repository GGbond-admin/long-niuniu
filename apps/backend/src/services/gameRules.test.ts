import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({
  rows: new Map<string, any>(),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    gameRuleDocument: {
      findUnique: vi.fn(async ({ where }: any) =>
        memory.rows.get(where.gameCode) ?? null,
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        const row = memory.rows.get(where.gameCode);
        return row?.status === where.status ? row : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const current = memory.rows.get(where.gameCode);
        const row = current
          ? {
              ...current,
              ...update,
              version:
                typeof update.version === 'object'
                  ? current.version + update.version.increment
                  : update.version,
            }
          : { id: `rules-${where.gameCode}`, ...create };
        memory.rows.set(where.gameCode, row);
        return row;
      }),
    },
  },
}));

import {
  gameRuleDocumentInput,
  getPublishedGameRules,
  saveGameRules,
} from './gameRules.js';

const publishedRules = {
  title: '测试游戏规则',
  summary: '规则摘要',
  sections: [{ id: 'flow', title: '流程', body: '先下注，再结算。' }],
  status: 'PUBLISHED' as const,
};

describe('游戏规则文档', () => {
  beforeEach(() => {
    memory.rows.clear();
  });

  it('拒绝 HTML、重复 section id 与超长正文', () => {
    expect(
      gameRuleDocumentInput.safeParse({
        ...publishedRules,
        summary: '<script>alert(1)</script>',
      }).success,
    ).toBe(false);
    expect(
      gameRuleDocumentInput.safeParse({
        ...publishedRules,
        sections: [
          publishedRules.sections[0],
          { id: 'flow', title: '重复', body: '重复章节' },
        ],
      }).success,
    ).toBe(false);
    expect(
      gameRuleDocumentInput.safeParse({
        ...publishedRules,
        sections: [{ id: 'flow', title: '流程', body: '字'.repeat(4_001) }],
      }).success,
    ).toBe(false);
  });

  it('草稿对玩家不可见，发布后仅在对应 gameCode 可见', async () => {
    await saveGameRules(
      'GAME_A',
      { ...publishedRules, status: 'DRAFT' },
      'admin-1',
    );
    await expect(getPublishedGameRules('GAME_A')).resolves.toBeNull();

    const saved = await saveGameRules('GAME_A', publishedRules, 'admin-1');
    await expect(getPublishedGameRules('GAME_A')).resolves.toEqual(saved.document);
    await expect(getPublishedGameRules('GAME_B')).resolves.toBeNull();
    expect(saved.document).toMatchObject({
      gameCode: 'GAME_A',
      status: 'PUBLISHED',
      version: 2,
      updatedBy: 'admin-1',
    });
  });
});

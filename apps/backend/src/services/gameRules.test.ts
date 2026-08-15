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
  ensureGameRuleDefaults,
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

  it('启动时将旧版系统简略规则升级为唯一的完整至尊牛牛规则', async () => {
    memory.rows.set('SUPREME_NIUNIU', {
      id: 'rules-supreme',
      gameCode: 'SUPREME_NIUNIU',
      title: '至尊牛牛游戏规则',
      summary: '旧版摘要',
      sections: [
        { id: 'flow', title: '游戏流程', body: '旧版流程' },
        { id: 'hands', title: '牌型与大小', body: '旧版牌型' },
        { id: 'betting', title: '下注与梭哈', body: '旧版下注' },
        { id: 'settlement', title: '结算与费用', body: '旧版结算' },
        { id: 'fairness', title: '公平与风险提示', body: '旧版提示' },
      ],
      status: 'PUBLISHED',
      version: 1,
      updatedBy: null,
      publishedAt: new Date(),
    });

    await ensureGameRuleDefaults();

    const document = memory.rows.get('SUPREME_NIUNIU');
    expect(document.title).toBe('至尊牛牛玩法规则');
    expect(document.summary).toBe('');
    expect(document.version).toBe(2);
    expect(document.sections.map((section: any) => section.title)).toEqual(
      expect.arrayContaining([
        '游戏简介',
        '在哪里玩',
        '游戏流程',
        '牌型与倍数（由高到低）',
        '注意事项',
      ]),
    );
    expect(JSON.stringify(document.sections)).toContain('至尊牛牛互动群');
    expect(JSON.stringify(document.sections)).not.toContain('12牛牛');
  });

  it('保留管理员章节结构，只替换遗留的 12牛牛 品牌名', async () => {
    memory.rows.set('SUPREME_NIUNIU', {
      id: 'rules-supreme',
      gameCode: 'SUPREME_NIUNIU',
      title: '12牛牛规则',
      summary: '欢迎参加12年牛',
      sections: [
        {
          id: 'custom',
          title: '自定义说明',
          body: '请进入12牛牛互动群。',
        },
      ],
      status: 'PUBLISHED',
      version: 7,
      updatedBy: 'admin-1',
      publishedAt: new Date(),
    });

    await ensureGameRuleDefaults();

    const document = memory.rows.get('SUPREME_NIUNIU');
    expect(document).toMatchObject({
      title: '至尊牛牛规则',
      summary: '欢迎参加至尊牛牛',
      version: 8,
      updatedBy: 'admin-1',
    });
    expect(document.sections).toEqual([
      {
        id: 'custom',
        title: '自定义说明',
        body: '请进入至尊牛牛互动群。',
      },
    ]);
  });
});

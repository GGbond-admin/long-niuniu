import { describe, expect, it } from 'vitest';
import { HOUSE_INVITER_NOTE } from '../services/houseInviter.js';
import { profitPoolUserOptionWhere } from './profitPool.js';

describe('利润池用户选择器过滤', () => {
  it('包含备注为空的普通用户，只排除官方邀请号', () => {
    const where = profitPoolUserOptionWhere('');
    expect(where.kind).toBe('HUMAN');
    expect(where).not.toHaveProperty('NOT');
    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [{ adminNote: null }, { adminNote: { not: HOUSE_INVITER_NOTE } }],
        },
      ]),
    );
  });

  it('关键词与官方号排除用 AND 组合，不会互相覆盖', () => {
    const where = profitPoolUserOptionWhere('张三');
    const and = where.AND as unknown[];
    expect(and).toHaveLength(2);
    expect(and[1]).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          { uid: { contains: '张三' } },
          { nickname: { contains: '张三', mode: 'insensitive' } },
        ]),
      }),
    );
  });

  it('纯数字同时按 UID 模糊和 Telegram ID 精确匹配', () => {
    const where = profitPoolUserOptionWhere('12345678');
    const search = (where.AND as Array<{ OR?: unknown[] }>)[1];
    expect(search.OR).toEqual(
      expect.arrayContaining([
        { uid: { contains: '12345678' } },
        { tgId: 12345678n },
      ]),
    );
  });
});

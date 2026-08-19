import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => {
  const revisions: Array<Record<string, any>> = [];
  const scoreboard = {
    id: 'score-1',
    roundId: 'round-1',
    seqNo: 8,
    playerLines: [
      {
        userId: 'player-1',
        uid: '1001',
        nickname: '玩家',
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
      nickname: '庄家',
      claimCents: '70',
      netCents: '-5000',
      balanceBeforeCents: '100000',
      balanceAfterCents: '95000',
    },
    publishedMessageId: null,
    presentation: null as unknown,
    presentationRevision: 0,
    presentationUpdatedBy: null as string | null,
    presentationSyncStatus: 'LEGACY',
    presentationSyncError: null as string | null,
    presentationSyncedAt: null as Date | null,
    publishedChatMessageIds: [] as string[],
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    updatedAt: new Date('2026-08-19T00:00:00.000Z'),
    round: {
      id: 'round-1',
      roomId: 'room-1',
      seqNo: 8,
      phase: 'FINISHED',
      settlements: [
        {
          userId: 'player-1',
          payableCents: 13_600n,
          paidCents: 13_600n,
          shortfallCents: 0n,
          rakeCents: 408n,
        },
      ],
    },
  };
  return {
    scoreboard,
    revisions,
    chat: new Map<string, { id: string; type: string; content: string; from: null; at: string }>(),
    roundEvents: [] as Array<Record<string, unknown>>,
    auditLogs: [] as Array<Record<string, unknown>>,
    lockAvailable: true,
    supersedeOnAppend: false,
    supersedeAsSynced: false,
    supersedeAsFailed: false,
    leaseAssertCalls: 0,
    leaseFailAt: null as number | null,
  };
});

function row() {
  return {
    ...memory.scoreboard,
    presentationRevisions: [...memory.revisions].sort(
      (left, right) => Number(right.revision) - Number(left.revision),
    ),
  };
}

const delegates = vi.hoisted(() => ({
  roundScoreboard: {
    findUnique: vi.fn(async () => row()),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const revisionFilter = where.presentationRevision;
      if (
        typeof revisionFilter === 'number'
        && memory.scoreboard.presentationRevision !== revisionFilter
      ) {
        return { count: 0 };
      }
      if (
        revisionFilter
        && typeof revisionFilter === 'object'
        && 'not' in revisionFilter
        && memory.scoreboard.presentationRevision === revisionFilter.not
      ) {
        return { count: 0 };
      }
      if (where.presentationSyncStatus) {
        const statusFilter = where.presentationSyncStatus;
        const matchesStatus =
          typeof statusFilter === 'string'
            ? memory.scoreboard.presentationSyncStatus === statusFilter
            : Array.isArray(statusFilter.in)
              && statusFilter.in.includes(memory.scoreboard.presentationSyncStatus);
        if (!matchesStatus) return { count: 0 };
      }
      if (
        Object.prototype.hasOwnProperty.call(where, 'presentationSyncedAt')
        && memory.scoreboard.presentationSyncedAt !== where.presentationSyncedAt
      ) {
        return { count: 0 };
      }
      Object.assign(memory.scoreboard, data, { updatedAt: new Date() });
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }: any) => {
      Object.assign(memory.scoreboard, data, { updatedAt: new Date() });
      return row();
    }),
  },
  roundScoreboardRevision: {
    findUnique: vi.fn(async ({ where }: any) =>
      memory.revisions.find(
        (revision) =>
          revision.scoreboardId === where.scoreboardId_revision.scoreboardId
          && revision.revision === where.scoreboardId_revision.revision,
      ) ?? null,
    ),
    create: vi.fn(async ({ data }: any) => {
      const revision = {
        id: `revision-${data.revision}`,
        ...data,
        createdAt: new Date(),
      };
      memory.revisions.push(revision);
      return revision;
    }),
  },
  roundEvent: {
    create: vi.fn(async ({ data }: any) => {
      memory.roundEvents.push(data);
      return data;
    }),
  },
  auditLog: {
    create: vi.fn(async ({ data }: any) => {
      memory.auditLogs.push(data);
      return data;
    }),
  },
  settlement: {
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  ledgerEntry: {
    create: vi.fn(),
    createMany: vi.fn(),
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    roundScoreboard: delegates.roundScoreboard,
    roundScoreboardRevision: delegates.roundScoreboardRevision,
    roundEvent: delegates.roundEvent,
    auditLog: delegates.auditLog,
    $transaction: vi.fn(async (work: (tx: typeof delegates) => Promise<unknown>) =>
      work(delegates),
    ),
  },
}));

vi.mock('./scoreboardSyncLock.js', () => {
  class ScoreboardSyncLockUnavailableError extends Error {}
  class ScoreboardSyncLockLostError extends Error {}
  return {
    ScoreboardSyncLockUnavailableError,
    ScoreboardSyncLockLostError,
    withScoreboardSyncLock: vi.fn(
      async (
        _roundId: string,
        work: (lease: {
          fence: null;
          assertHeld: () => Promise<void>;
        }) => Promise<unknown>,
      ) => {
        if (!memory.lockAvailable) throw new ScoreboardSyncLockUnavailableError();
        return work({
          fence: null,
          assertHeld: async () => {
            memory.leaseAssertCalls += 1;
            if (memory.leaseAssertCalls === memory.leaseFailAt) {
              throw new ScoreboardSyncLockLostError();
            }
          },
        });
      },
    ),
  };
});

const chatDelegates = vi.hoisted(() => ({
  appendChatOnce: vi.fn(async (_roomId: string, id: string, message: any) => {
    const value = {
      ...message,
      id,
      at: new Date().toISOString(),
    };
    memory.chat.set(id, value);
    if (memory.supersedeOnAppend) {
      memory.supersedeOnAppend = false;
      memory.scoreboard.presentationRevision += 1;
      memory.scoreboard.presentation = {};
      memory.scoreboard.presentationSyncStatus =
        memory.supersedeAsSynced
          ? 'SYNCED'
          : memory.supersedeAsFailed
            ? 'FAILED'
            : 'PENDING';
      if (memory.supersedeAsSynced) {
        memory.scoreboard.publishedChatMessageIds = ['newer-sync-message'];
        memory.scoreboard.presentationSyncedAt = new Date();
      }
    }
    return value;
  }),
  updateChatStrict: vi.fn(async (_roomId: string, id: string, patch: any) => {
    const current = memory.chat.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    memory.chat.set(id, next);
    return next;
  }),
  deleteChatStrict: vi.fn(async (_roomId: string, id: string) => memory.chat.delete(id)),
  existingChatMessageIds: vi.fn(
    async (_roomId: string, ids: readonly string[]) =>
      ids.filter((id) => memory.chat.has(id)),
  ),
  existingChatMessagesByPrefix: vi.fn(
    async (_roomId: string, prefix: string) =>
      [...memory.chat.values()]
        .filter((message) => message.id.startsWith(prefix))
        .sort((left, right) => left.id.localeCompare(right.id)),
  ),
}));

vi.mock('./roomHub.js', () => chatDelegates);

import {
  restoreScoreboardPresentation,
  saveScoreboardPresentation,
  saveAndSyncScoreboardPresentation,
  previewScoreboardPresentation,
  scoreboardPresentationInput,
  ScoreboardPresentationError,
  syncScoreboardPresentation,
} from './scoreboardPresentation.js';

describe('成绩单展示修订', () => {
  beforeEach(() => {
    memory.scoreboard.playerLines = [
      {
        userId: 'player-1',
        uid: '1001',
        nickname: '玩家',
        claimCents: '111',
        betCents: '800',
        outcome: 'PLAYER_WIN',
        netCents: '13192',
        shortfallCents: '0',
        balanceBeforeCents: '500111',
        balanceAfterCents: '513303',
      },
    ];
    memory.scoreboard.presentation = null;
    memory.scoreboard.presentationRevision = 0;
    memory.scoreboard.presentationUpdatedBy = null;
    memory.scoreboard.presentationSyncStatus = 'LEGACY';
    memory.scoreboard.presentationSyncError = null;
    memory.scoreboard.presentationSyncedAt = null;
    memory.scoreboard.publishedChatMessageIds = [];
    memory.revisions.length = 0;
    memory.chat.clear();
    memory.roundEvents.length = 0;
    memory.auditLogs.length = 0;
    memory.lockAvailable = true;
    memory.supersedeOnAppend = false;
    memory.supersedeAsSynced = false;
    memory.supersedeAsFailed = false;
    memory.leaseAssertCalls = 0;
    memory.leaseFailAt = null;
    vi.clearAllMocks();
  });

  it('拒绝通过展示接口提交金额、输赢或余额字段', () => {
    expect(
      scoreboardPresentationInput.safeParse({
        title: '更正成绩单',
        netCents: '999999',
      }).success,
    ).toBe(false);
    expect(
      scoreboardPresentationInput.safeParse({
        playerAliases: {},
        playerNotes: {},
        bankerSummary: { netCents: '999999' },
      }).success,
    ).toBe(false);
    expect(
      scoreboardPresentationInput.safeParse({
        title: '<script>伪造标题</script>',
      }).success,
    ).toBe(false);
    expect(
      scoreboardPresentationInput.safeParse({
        playerAliases: { 'player-1': '第一行\n伪造金额' },
      }).success,
    ).toBe(false);
  });

  it('保存展示修订但保持真实结算内容完全不变', async () => {
    const originalPlayers = structuredClone(memory.scoreboard.playerLines);
    const originalBanker = structuredClone(memory.scoreboard.bankerSummary);

    const result = await saveScoreboardPresentation({
      roundId: 'round-1',
      adminId: 'admin-1',
      ip: '127.0.0.1',
      input: {
        expectedRevision: 0,
        reason: '修正玩家展示名称',
        presentation: {
          title: '第 8 局复核成绩单',
          playerAliases: { 'player-1': '新玩家名' },
          playerNotes: { 'player-1': '展示名已核对' },
          footer: '本次只修改展示。',
        },
      },
    });

    expect(memory.scoreboard.playerLines).toEqual(originalPlayers);
    expect(memory.scoreboard.bankerSummary).toEqual(originalBanker);
    expect(memory.scoreboard.presentationRevision).toBe(1);
    expect(memory.scoreboard.presentationSyncStatus).toBe('PENDING');
    expect(delegates.settlement.update).not.toHaveBeenCalled();
    expect(delegates.settlement.updateMany).not.toHaveBeenCalled();
    expect(delegates.ledgerEntry.create).not.toHaveBeenCalled();
    expect(delegates.ledgerEntry.createMany).not.toHaveBeenCalled();
    expect(memory.revisions).toHaveLength(2);
    expect(memory.revisions.find((revision) => revision.revision === 0)).toMatchObject({
      reason: '系统原始展示',
      adminId: 'system',
    });
    expect(memory.roundEvents[0]).toMatchObject({
      type: 'SCOREBOARD_PRESENTATION_UPDATED',
      actorId: 'admin-1',
    });
    expect(memory.auditLogs[0]).toMatchObject({
      action: 'scoreboard_presentation_update',
      target: 'round-1',
    });
    expect(result.previewChunks.join('\n')).toContain('@新玩家名');
    expect(result.previewChunks.join('\n')).toContain('赢→131.92');
    expect(result.playerLines[0]).toMatchObject({
      payableCents: '13600',
      paidCents: '13600',
      shortfallCents: '0',
      rakeCents: '408',
    });
  });

  it('预览复用服务端格式器且不创建修订或审计记录', async () => {
    const preview = await previewScoreboardPresentation('round-1', {
      playerAliases: { 'player-1': 'A&B&C' },
      footer: '仅预览 & 不保存',
    });

    expect(preview.previewChunks.join('\n')).toContain('@A&B&C');
    expect(preview.previewChunks.join('\n')).toContain('仅预览 & 不保存');
    expect(delegates.roundScoreboard.updateMany).not.toHaveBeenCalled();
    expect(memory.revisions).toEqual([]);
    expect(memory.auditLogs).toEqual([]);
  });

  it('Redis 同步锁不可用时仍保留数据库修订并标记同步失败', async () => {
    memory.lockAvailable = false;

    await expect(
      saveAndSyncScoreboardPresentation({
        roundId: 'round-1',
        adminId: 'admin-1',
        input: {
          expectedRevision: 0,
          reason: '修正展示名称',
          presentation: { bankerAlias: '新庄家名' },
        },
      }),
    ).rejects.toMatchObject({ code: 'SCOREBOARD_SYNC_FAILED' });

    expect(memory.scoreboard.presentationRevision).toBe(1);
    expect(memory.scoreboard.presentation).toMatchObject({ bankerAlias: '新庄家名' });
    expect(memory.scoreboard.presentationSyncStatus).toBe('FAILED');
    expect(memory.revisions.map((revision) => revision.revision)).toEqual([0, 1]);
  });

  it('拒绝修改不属于本局的玩家展示信息', async () => {
    await expect(
      saveScoreboardPresentation({
        roundId: 'round-1',
        adminId: 'admin-1',
        input: {
          expectedRevision: 0,
          reason: '错误玩家测试',
          presentation: {
            playerAliases: { 'player-other': '不属于本局' },
          },
        },
      }),
    ).rejects.toMatchObject<Partial<ScoreboardPresentationError>>({
      code: 'SCOREBOARD_PLAYER_NOT_FOUND',
      statusCode: 400,
    });
  });

  it('使用修订号乐观锁阻止两个管理员互相覆盖', async () => {
    memory.scoreboard.presentationRevision = 1;
    await expect(
      saveScoreboardPresentation({
        roundId: 'round-1',
        adminId: 'admin-2',
        input: {
          expectedRevision: 0,
          reason: '并发覆盖测试',
          presentation: { footer: '旧页面提交' },
        },
      }),
    ).rejects.toMatchObject<Partial<ScoreboardPresentationError>>({
      code: 'SCOREBOARD_REVISION_CONFLICT',
      statusCode: 409,
    });
  });

  it('兼容旧成绩单消息 ID 并原位同步，不追加重复成绩单', async () => {
    const settlingId = 'round:round-1:announce:FINISHED:0';
    const legacyId = 'round:round-1:announce:FINISHED:1';
    const continuationId = 'round:round-1:announce:FINISHED:2';
    memory.chat.set(settlingId, {
      id: settlingId,
      type: 'SYSTEM',
      content: '⏳ 正在生成本局成绩单，请稍候…',
      from: null,
      at: new Date().toISOString(),
    });
    memory.chat.set(legacyId, {
      id: legacyId,
      type: 'SYSTEM',
      content:
        '🏆 至尊牛牛 · 第 8 局成绩单\n@player · RM 1.11\n🎲 庄家 @banker · RM 0.70\n走势：—',
      from: null,
      at: new Date().toISOString(),
    });
    memory.chat.set(continuationId, {
      id: continuationId,
      type: 'SYSTEM',
      content: '下一局准备就绪，请留意群内提示',
      from: null,
      at: new Date().toISOString(),
    });

    const result = await saveAndSyncScoreboardPresentation({
      roundId: 'round-1',
      adminId: 'admin-1',
      input: {
        expectedRevision: 0,
        reason: '同步展示更正',
        presentation: { footer: '展示信息已复核。' },
      },
    });

    expect(memory.chat.size).toBe(3);
    expect(memory.chat.get(settlingId)?.content).toContain('正在生成');
    expect(memory.chat.get(legacyId)?.content).toContain('展示信息已复核');
    expect(memory.chat.has(continuationId)).toBe(true);
    expect(memory.scoreboard.publishedChatMessageIds).toEqual([legacyId]);
    expect(memory.scoreboard.presentationSyncStatus).toBe('SYNCED');
    expect(result.presentationSyncStatus).toBe('SYNCED');
    expect(memory.roundEvents).toContainEqual(
      expect.objectContaining({
        type: 'SCOREBOARD_PRESENTATION_SYNCED',
        actorId: 'admin-1',
      }),
    );
    expect(memory.auditLogs).toContainEqual(
      expect.objectContaining({
        action: 'scoreboard_presentation_sync',
        target: 'round-1',
      }),
    );
  });

  it('旧版成绩单序号存在缺口时标记过期，不压缩分段或误改其它话术', async () => {
    const firstId = 'round:round-1:announce:FINISHED:1';
    const thirdId = 'round:round-1:announce:FINISHED:3';
    memory.chat.set(firstId, {
      id: firstId,
      type: 'SYSTEM',
      content: '🏆 第 8 局成绩单\n🟢 @player · +RM 1.00',
      from: null,
      at: new Date().toISOString(),
    });
    memory.chat.set(thirdId, {
      id: thirdId,
      type: 'SYSTEM',
      content: '🎲 庄家 @banker · RM 0.70\n走势：—',
      from: null,
      at: new Date().toISOString(),
    });

    const result = await saveAndSyncScoreboardPresentation({
      roundId: 'round-1',
      adminId: 'admin-1',
      input: {
        expectedRevision: 0,
        reason: '缺失分段测试',
        presentation: { footer: '不得追加。' },
      },
    });

    expect(result.presentationSyncStatus).toBe('MESSAGE_EXPIRED');
    expect(chatDelegates.updateChatStrict).not.toHaveBeenCalled();
    expect(chatDelegates.appendChatOnce).not.toHaveBeenCalled();
    expect(memory.chat.get(thirdId)?.content).toContain('庄家');
  });

  it('原消息超过聊天保留期时标记过期，不把历史成绩单插入当前群', async () => {
    const result = await saveAndSyncScoreboardPresentation({
      roundId: 'round-1',
      adminId: 'admin-1',
      input: {
        expectedRevision: 0,
        reason: '过期消息测试',
        presentation: { footer: '只保存后台展示。' },
      },
    });

    expect(memory.chat.size).toBe(0);
    expect(chatDelegates.appendChatOnce).not.toHaveBeenCalled();
    expect(memory.scoreboard.presentationSyncStatus).toBe('MESSAGE_EXPIRED');
    expect(result.presentationSyncStatus).toBe('MESSAGE_EXPIRED');
  });

  it('恢复旧版本时创建新修订，不覆盖历史版本', async () => {
    await saveScoreboardPresentation({
      roundId: 'round-1',
      adminId: 'admin-1',
      input: {
        expectedRevision: 0,
        reason: '建立第一个展示版本',
        presentation: { playerAliases: { 'player-1': '第一版名称' } },
      },
    });
    await saveScoreboardPresentation({
      roundId: 'round-1',
      adminId: 'admin-2',
      input: {
        expectedRevision: 1,
        reason: '建立第二个展示版本',
        presentation: { playerAliases: { 'player-1': '第二版名称' } },
      },
    });

    const restored = await restoreScoreboardPresentation({
      roundId: 'round-1',
      revision: 1,
      expectedRevision: 2,
      reason: '复核后恢复第一版本',
      adminId: 'admin-3',
    });

    expect(restored.presentationRevision).toBe(3);
    expect(restored.presentation.playerAliases?.['player-1']).toBe('第一版名称');
    expect(restored.revisions.map((revision) => revision.revision)).toEqual([3, 2, 1, 0]);
    expect(memory.revisions).toHaveLength(4);
    expect(memory.roundEvents.at(-1)).toMatchObject({
      type: 'SCOREBOARD_PRESENTATION_RESTORED',
      payload: { restoredFromRevision: 1 },
    });
    expect(memory.auditLogs.at(-1)).toMatchObject({
      action: 'scoreboard_presentation_restore',
    });
  });

  it('成绩单分段减少时更新保留段并广播删除多余旧段', async () => {
    const firstId = 'round:round-1:scoreboard:0';
    const staleId = 'round:round-1:scoreboard:1';
    memory.scoreboard.presentation = { footer: '单段成绩单' };
    memory.scoreboard.presentationRevision = 1;
    memory.scoreboard.publishedChatMessageIds = [firstId, staleId];
    for (const id of [firstId, staleId]) {
      memory.chat.set(id, {
        id,
        type: 'SYSTEM',
        content: '旧分段',
        from: null,
        at: new Date().toISOString(),
      });
    }

    const result = await syncScoreboardPresentation('round-1');

    expect(chatDelegates.updateChatStrict).toHaveBeenCalledWith(
      'room-1',
      firstId,
      expect.objectContaining({ type: 'SYSTEM' }),
      expect.anything(),
    );
    expect(chatDelegates.deleteChatStrict).toHaveBeenCalledWith(
      'room-1',
      staleId,
      expect.anything(),
    );
    expect(memory.chat.has(staleId)).toBe(false);
    expect(result.publishedChatMessageIds).toEqual([firstId]);
  });

  it('同步中修订被取代时记录实际消息映射，下一修订可清理旧分段', async () => {
    memory.scoreboard.playerLines = Array.from({ length: 80 }, (_value, index) => ({
      userId: `race-player-${index}`,
      uid: String(30_000 + index),
      nickname: `并发玩家${index}`,
      claimCents: '111',
      betCents: '800',
      outcome: 'PLAYER_WIN',
      netCents: '13192',
      shortfallCents: '0',
      balanceBeforeCents: '500111',
      balanceAfterCents: '513303',
    }));
    memory.scoreboard.presentationRevision = 1;
    memory.scoreboard.presentation = {
      playerNotes: Object.fromEntries(
        memory.scoreboard.playerLines.map((player) => [
          player.userId,
          `旧修订长备注-${player.userId}-${'说明'.repeat(35)}`,
        ]),
      ),
    };
    const firstId = 'round:round-1:scoreboard:0';
    memory.scoreboard.publishedChatMessageIds = [firstId];
    memory.chat.set(firstId, {
      id: firstId,
      type: 'SYSTEM',
      content: '第一段旧内容',
      from: null,
      at: new Date().toISOString(),
    });
    memory.supersedeOnAppend = true;

    const superseded = await syncScoreboardPresentation('round-1');
    const supersededIds = [...memory.scoreboard.publishedChatMessageIds];

    expect(superseded.presentationRevision).toBe(2);
    expect(supersededIds.length).toBeGreaterThan(superseded.previewChunks.length);
    expect(supersededIds.every((id) => memory.chat.has(id))).toBe(true);

    const repaired = await syncScoreboardPresentation('round-1');
    expect(repaired.publishedChatMessageIds).toHaveLength(repaired.previewChunks.length);
    for (const staleId of supersededIds.slice(repaired.previewChunks.length)) {
      expect(memory.chat.has(staleId)).toBe(false);
    }
  });

  it('被取代同步不得覆盖已完成的新修订消息映射', async () => {
    memory.scoreboard.playerLines = Array.from({ length: 80 }, (_value, index) => ({
      userId: `cas-player-${index}`,
      uid: String(35_000 + index),
      nickname: `映射保护玩家${index}`,
      claimCents: '111',
      betCents: '800',
      outcome: 'PLAYER_WIN',
      netCents: '13192',
      shortfallCents: '0',
      balanceBeforeCents: '500111',
      balanceAfterCents: '513303',
    }));
    memory.scoreboard.presentationRevision = 1;
    memory.scoreboard.presentationSyncStatus = 'PENDING';
    const firstId = 'round:round-1:scoreboard:0';
    memory.scoreboard.publishedChatMessageIds = [firstId];
    memory.chat.set(firstId, {
      id: firstId,
      type: 'SYSTEM',
      content: '旧修订第一段',
      from: null,
      at: new Date().toISOString(),
    });
    memory.supersedeOnAppend = true;
    memory.supersedeAsSynced = true;

    const result = await syncScoreboardPresentation('round-1');

    expect(result.presentationRevision).toBe(2);
    expect(result.presentationSyncStatus).toBe('SYNCED');
    expect(result.publishedChatMessageIds).toEqual(['newer-sync-message']);
  });

  it('新修订等待锁失败后仍接收旧持锁者已经产生的真实消息映射', async () => {
    memory.scoreboard.playerLines = Array.from({ length: 80 }, (_value, index) => ({
      userId: `failed-player-${index}`,
      uid: String(50_000 + index),
      nickname: `失败接管玩家${index}`,
      claimCents: '111',
      betCents: '800',
      outcome: 'PLAYER_WIN',
      netCents: '13192',
      shortfallCents: '0',
      balanceBeforeCents: '500111',
      balanceAfterCents: '513303',
    }));
    memory.scoreboard.presentationRevision = 1;
    memory.scoreboard.presentationSyncStatus = 'PENDING';
    memory.scoreboard.presentation = {};
    const firstId = 'round:round-1:scoreboard:0';
    memory.scoreboard.publishedChatMessageIds = [firstId];
    memory.chat.set(firstId, {
      id: firstId,
      type: 'SYSTEM',
      content: '旧修订第一段',
      from: null,
      at: new Date().toISOString(),
    });
    memory.supersedeOnAppend = true;
    memory.supersedeAsFailed = true;

    const result = await syncScoreboardPresentation('round-1');

    expect(result.presentationRevision).toBe(2);
    expect(result.presentationSyncStatus).toBe('FAILED');
    expect(result.publishedChatMessageIds).toHaveLength(result.previewChunks.length);
    expect(result.publishedChatMessageIds.length).toBeGreaterThan(1);
    expect(result.publishedChatMessageIds[1]).toBe('round:round-1:scoreboard:1');
  });

  it('主成绩单分段已过期时不因残留次段而重新插入历史消息', async () => {
    const firstId = 'round:round-1:scoreboard:0';
    const secondId = 'round:round-1:scoreboard:1';
    memory.scoreboard.presentation = { footer: '历史成绩单' };
    memory.scoreboard.presentationRevision = 1;
    memory.scoreboard.publishedChatMessageIds = [firstId, secondId];
    memory.chat.set(secondId, {
      id: secondId,
      type: 'SYSTEM',
      content: '残留次段',
      from: null,
      at: new Date().toISOString(),
    });

    const result = await syncScoreboardPresentation('round-1');

    expect(chatDelegates.appendChatOnce).not.toHaveBeenCalled();
    expect(result.presentationSyncStatus).toBe('MESSAGE_EXPIRED');
    expect(memory.chat.has(firstId)).toBe(false);
  });

  it('已映射的中间分段缺失时在任何消息更新前终止同步', async () => {
    const firstId = 'round:round-1:scoreboard:0';
    const secondId = 'round:round-1:scoreboard:1';
    memory.scoreboard.playerLines = Array.from({ length: 80 }, (_value, index) => ({
      userId: `player-${index}`,
      uid: String(10_000 + index),
      nickname: `很长的玩家展示名称${index}`,
      claimCents: '111',
      betCents: '800',
      outcome: 'PLAYER_WIN',
      netCents: '13192',
      shortfallCents: '0',
      balanceBeforeCents: '500111',
      balanceAfterCents: '513303',
    }));
    memory.scoreboard.presentationRevision = 1;
    memory.scoreboard.publishedChatMessageIds = [firstId, secondId];
    memory.chat.set(firstId, {
      id: firstId,
      type: 'SYSTEM',
      content: '第一段旧内容',
      from: null,
      at: new Date().toISOString(),
    });

    const result = await syncScoreboardPresentation('round-1');

    expect(result.previewChunks.length).toBeGreaterThan(1);
    expect(result.presentationSyncStatus).toBe('MESSAGE_EXPIRED');
    expect(chatDelegates.updateChatStrict).not.toHaveBeenCalled();
    expect(chatDelegates.appendChatOnce).not.toHaveBeenCalled();
  });

  it('记录消息过期状态时 lease 丢失必须返回同步失败', async () => {
    memory.scoreboard.playerLines = Array.from({ length: 80 }, (_value, index) => ({
      userId: `expiry-player-${index}`,
      uid: String(40_000 + index),
      nickname: `过期测试玩家${index}`,
      claimCents: '111',
      betCents: '800',
      outcome: 'PLAYER_WIN',
      netCents: '13192',
      shortfallCents: '0',
      balanceBeforeCents: '500111',
      balanceAfterCents: '513303',
    }));
    const firstId = 'round:round-1:scoreboard:0';
    const missingId = 'round:round-1:scoreboard:1';
    memory.scoreboard.presentationRevision = 1;
    memory.scoreboard.publishedChatMessageIds = [firstId, missingId];
    memory.chat.set(firstId, {
      id: firstId,
      type: 'SYSTEM',
      content: '仅剩第一段',
      from: null,
      at: new Date().toISOString(),
    });
    memory.leaseFailAt = 2;

    await expect(syncScoreboardPresentation('round-1')).rejects.toMatchObject({
      code: 'SCOREBOARD_SYNC_FAILED',
      statusCode: 503,
    });
    expect(memory.scoreboard.presentationSyncStatus).toBe('LEGACY');
  });
});

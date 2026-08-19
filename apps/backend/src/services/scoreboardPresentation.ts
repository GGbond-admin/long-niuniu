import {
  Prisma,
  RoundPhase,
  ScoreboardSyncStatus,
  type RoundScoreboard,
} from '@prisma/client';
import { z } from 'zod';
import {
  appendChatOnce,
  deleteChatStrict,
  existingChatMessageIds,
  existingChatMessagesByPrefix,
  updateChatStrict,
} from './roomHub.js';
import {
  formatScoreboardPlainText,
  type ScoreboardPresentation,
} from '../bot/messages.js';
import { compareScoreboardHandOrder } from '../engine/settlement.js';
import { prisma } from '../lib/prisma.js';
import {
  ScoreboardSyncLockLostError,
  ScoreboardSyncLockUnavailableError,
  type ScoreboardSyncLease,
  withScoreboardSyncLock,
} from './scoreboardSyncLock.js';

const htmlTag = /<\/?[a-z][^>]*>/i;
const unsafeControlCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !htmlTag.test(value), {
      message: '成绩单展示只允许纯文本，不允许 HTML 标签',
    })
    .refine((value) => !unsafeControlCharacter.test(value), {
      message: '成绩单展示包含不允许的控制字符',
    });
const singleLineText = (max: number) =>
  plainText(max).refine((value) => !/[\r\n]/.test(value), {
    message: '该字段必须是单行文本',
  });

export const scoreboardPresentationInput = z
  .object({
    title: singleLineText(120).optional(),
    playerAliases: z.record(singleLineText(80)).optional(),
    playerNotes: z.record(singleLineText(160)).optional(),
    bankerAlias: singleLineText(80).optional(),
    bankerNote: singleLineText(160).optional(),
    footer: plainText(500).optional(),
  })
  .strict();

export const scoreboardPresentationMutationInput = z
  .object({
    expectedRevision: z.number().int().min(0),
    reason: plainText(500).refine((value) => value.length >= 4, {
      message: '修改原因至少需要 4 个字符',
    }),
    presentation: scoreboardPresentationInput,
  })
  .strict();

export type ScoreboardPresentationMutation = z.infer<
  typeof scoreboardPresentationMutationInput
>;

export class ScoreboardPresentationError extends Error {
  constructor(
    public code:
      | 'SCOREBOARD_NOT_FOUND'
      | 'SCOREBOARD_NOT_FINISHED'
      | 'SCOREBOARD_REVISION_CONFLICT'
      | 'SCOREBOARD_PLAYER_NOT_FOUND'
      | 'SCOREBOARD_REVISION_NOT_FOUND'
      | 'SCOREBOARD_SYNC_FAILED',
    public statusCode: number,
  ) {
    super(code);
  }
}

function compactMap(values: Record<string, string> | undefined): Record<string, string> {
  if (!values) return {};
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
}

export function normalizeScoreboardPresentation(
  input: z.input<typeof scoreboardPresentationInput>,
): ScoreboardPresentation {
  const parsed = scoreboardPresentationInput.parse(input);
  const normalized: ScoreboardPresentation = {
    playerAliases: Object.fromEntries(
      Object.entries(compactMap(parsed.playerAliases))
        .map(([key, value]) => [key, value.replace(/^@+/, '').trim()] as const)
        .filter(([_key, value]) => value.length > 0),
    ),
    playerNotes: compactMap(parsed.playerNotes),
  };
  const title = parsed.title?.trim();
  const bankerAlias = parsed.bankerAlias?.trim();
  const bankerNote = parsed.bankerNote?.trim();
  const footer = parsed.footer?.trim();
  if (title) normalized.title = title;
  if (bankerAlias?.replace(/^@+/, '').trim()) {
    normalized.bankerAlias = bankerAlias.replace(/^@+/, '').trim();
  }
  if (bankerNote) normalized.bankerNote = bankerNote;
  if (footer) normalized.footer = footer;
  return normalized;
}

export function parseStoredScoreboardPresentation(
  value: Prisma.JsonValue | null,
): ScoreboardPresentation {
  const parsed = scoreboardPresentationInput.safeParse(value ?? {});
  return parsed.success ? normalizeScoreboardPresentation(parsed.data) : {
    playerAliases: {},
    playerNotes: {},
  };
}

function playerLines(scoreboard: Pick<RoundScoreboard, 'playerLines'>) {
  return Array.isArray(scoreboard.playerLines)
    ? (scoreboard.playerLines as Array<Record<string, unknown>>)
    : [];
}

function assertPresentationPlayers(
  scoreboard: Pick<RoundScoreboard, 'playerLines'>,
  presentation: ScoreboardPresentation,
) {
  const playerIds = new Set(
    playerLines(scoreboard).flatMap((line) =>
      typeof line.userId === 'string' ? [line.userId] : [],
    ),
  );
  for (const userId of [
    ...Object.keys(presentation.playerAliases ?? {}),
    ...Object.keys(presentation.playerNotes ?? {}),
  ]) {
    if (!playerIds.has(userId)) {
      throw new ScoreboardPresentationError('SCOREBOARD_PLAYER_NOT_FOUND', 400);
    }
  }
}

const scoreboardInclude = {
  round: {
    select: {
      id: true,
      roomId: true,
      seqNo: true,
      phase: true,
        settlements: {
          select: {
            userId: true,
            payableCents: true,
            paidCents: true,
            shortfallCents: true,
            rakeCents: true,
          },
        },
    },
  },
  presentationRevisions: {
    orderBy: { revision: 'desc' as const },
  },
} satisfies Prisma.RoundScoreboardInclude;

async function requireScoreboard(roundId: string) {
  const scoreboard = await prisma.roundScoreboard.findUnique({
    where: { roundId },
    include: scoreboardInclude,
  });
  if (!scoreboard) {
    throw new ScoreboardPresentationError('SCOREBOARD_NOT_FOUND', 404);
  }
  if (scoreboard.round.phase !== RoundPhase.FINISHED) {
    throw new ScoreboardPresentationError('SCOREBOARD_NOT_FINISHED', 409);
  }
  return scoreboard;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function scoreboardPresentationView(
  scoreboard: Awaited<ReturnType<typeof requireScoreboard>>,
) {
  const presentation = parseStoredScoreboardPresentation(scoreboard.presentation);
  const settlements = 'settlements' in scoreboard.round
    && Array.isArray(scoreboard.round.settlements)
    ? scoreboard.round.settlements
    : [];
  const settlementByUser = new Map(
    settlements.map((settlement) => [settlement.userId, settlement] as const),
  );
  const orderedPlayerLines = playerLines(scoreboard)
    .map((line) => {
      const userId = typeof line.userId === 'string' ? line.userId : '';
      const settlement = settlementByUser.get(userId);
      return settlement
        ? {
            ...line,
            payableCents: String(settlement.payableCents),
            paidCents: String(settlement.paidCents),
            shortfallCents: String(settlement.shortfallCents),
            rakeCents: String(settlement.rakeCents),
          }
        : line;
    })
    .slice()
    .sort(compareScoreboardHandOrder);
  return {
    id: scoreboard.id,
    roundId: scoreboard.roundId,
    roomId: scoreboard.round.roomId,
    seqNo: scoreboard.seqNo,
    playerLines: orderedPlayerLines,
    bankerSummary: scoreboard.bankerSummary,
    presentation,
    presentationRevision: scoreboard.presentationRevision,
    presentationUpdatedBy: scoreboard.presentationUpdatedBy,
    presentationSyncStatus: scoreboard.presentationSyncStatus,
    presentationSyncError: scoreboard.presentationSyncError,
    presentationSyncedAt: scoreboard.presentationSyncedAt,
    publishedChatMessageIds: Array.isArray(scoreboard.publishedChatMessageIds)
      ? scoreboard.publishedChatMessageIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    previewChunks: formatScoreboardPlainText(scoreboard, presentation),
    createdAt: scoreboard.createdAt,
    updatedAt: scoreboard.updatedAt,
    revisions: scoreboard.presentationRevisions.map((revision) => ({
      id: revision.id,
      revision: revision.revision,
      presentation: parseStoredScoreboardPresentation(revision.presentation),
      renderedChunks: Array.isArray(revision.renderedChunks)
        ? revision.renderedChunks.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
      reason: revision.reason,
      adminId: revision.adminId,
      createdAt: revision.createdAt,
    })),
  };
}

export async function getScoreboardPresentation(roundId: string) {
  return scoreboardPresentationView(await requireScoreboard(roundId));
}

export async function previewScoreboardPresentation(
  roundId: string,
  input: z.input<typeof scoreboardPresentationInput>,
) {
  const scoreboard = await requireScoreboard(roundId);
  const presentation = normalizeScoreboardPresentation(input);
  assertPresentationPlayers(scoreboard, presentation);
  return {
    presentation,
    previewChunks: formatScoreboardPlainText(scoreboard, presentation),
  };
}

export async function saveScoreboardPresentation(params: {
  roundId: string;
  adminId: string;
  ip?: string;
  input: ScoreboardPresentationMutation;
  operation?: 'UPDATE' | 'RESTORE';
  restoredFromRevision?: number;
}) {
  const input = scoreboardPresentationMutationInput.parse(params.input);
  const current = await requireScoreboard(params.roundId);
  const presentation = normalizeScoreboardPresentation(input.presentation);
  assertPresentationPlayers(current, presentation);
  const nextRevision = input.expectedRevision + 1;
  const renderedChunks = formatScoreboardPlainText(current, presentation);
  const beforePresentation = parseStoredScoreboardPresentation(current.presentation);
  const originalRenderedChunks = formatScoreboardPlainText(
    current,
    beforePresentation,
  );

  await prisma.$transaction(async (tx) => {
    const updated = await tx.roundScoreboard.updateMany({
      where: {
        id: current.id,
        presentationRevision: input.expectedRevision,
      },
      data: {
        presentation: toJson(presentation),
        presentationRevision: nextRevision,
        presentationUpdatedBy: params.adminId,
        presentationSyncStatus: ScoreboardSyncStatus.PENDING,
        presentationSyncError: null,
        presentationSyncedAt: null,
      },
    });
    if (updated.count !== 1) {
      throw new ScoreboardPresentationError('SCOREBOARD_REVISION_CONFLICT', 409);
    }
    if (input.expectedRevision === 0) {
      await tx.roundScoreboardRevision.create({
        data: {
          scoreboardId: current.id,
          revision: 0,
          presentation: toJson(beforePresentation),
          renderedChunks: toJson(originalRenderedChunks),
          reason: '系统原始展示',
          adminId: 'system',
        },
      });
    }
    await tx.roundScoreboardRevision.create({
      data: {
        scoreboardId: current.id,
        revision: nextRevision,
        presentation: toJson(presentation),
        renderedChunks: toJson(renderedChunks),
        reason: input.reason,
        adminId: params.adminId,
      },
    });
    await tx.roundEvent.create({
      data: {
        roundId: current.roundId,
        type:
          params.operation === 'RESTORE'
            ? 'SCOREBOARD_PRESENTATION_RESTORED'
            : 'SCOREBOARD_PRESENTATION_UPDATED',
        actorId: params.adminId,
        payload: {
          previousRevision: input.expectedRevision,
          revision: nextRevision,
          reason: input.reason,
          ...(params.restoredFromRevision != null
            ? { restoredFromRevision: params.restoredFromRevision }
            : {}),
        },
      },
    });
    await tx.auditLog.create({
      data: {
        adminId: params.adminId,
        action:
          params.operation === 'RESTORE'
            ? 'scoreboard_presentation_restore'
            : 'scoreboard_presentation_update',
        target: current.roundId,
        before: toJson({
          revision: input.expectedRevision,
          presentation: beforePresentation,
        }),
        after: toJson({
          revision: nextRevision,
          presentation,
          syncStatus: ScoreboardSyncStatus.PENDING,
          restoredFromRevision: params.restoredFromRevision,
        }),
        ip: params.ip,
      },
    });
  });

  return getScoreboardPresentation(params.roundId);
}

export async function restoreScoreboardPresentation(params: {
  roundId: string;
  revision: number;
  expectedRevision: number;
  reason: string;
  adminId: string;
  ip?: string;
}) {
  const scoreboard = await requireScoreboard(params.roundId);
  const revision = await prisma.roundScoreboardRevision.findUnique({
    where: {
      scoreboardId_revision: {
        scoreboardId: scoreboard.id,
        revision: params.revision,
      },
    },
  });
  if (!revision) {
    throw new ScoreboardPresentationError('SCOREBOARD_REVISION_NOT_FOUND', 404);
  }
  return saveScoreboardPresentation({
    roundId: params.roundId,
    adminId: params.adminId,
    ip: params.ip,
    operation: 'RESTORE',
    restoredFromRevision: params.revision,
    input: {
      expectedRevision: params.expectedRevision,
      reason: params.reason,
      presentation: parseStoredScoreboardPresentation(revision.presentation),
    },
  });
}

function semanticScoreboardMessageId(roundId: string, index: number): string {
  return `round:${roundId}:scoreboard:${index}`;
}

function discoverLegacyScoreboardMessageIds(
  messages: Array<{ id: string; content: string }>,
  prefix: string,
): { ids: string[]; incomplete: boolean } {
  const byIndex = new Map<number, { id: string; content: string }>();
  for (const message of messages) {
    const suffix = message.id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    byIndex.set(Number(suffix), message);
  }
  // 旧版 FINISHED 的 :0 固定是“正在生成成绩单”，真正成绩单从 :1 开始。
  const first = byIndex.get(1);
  if (!first || !/^\s*🏆/.test(first.content)) {
    return { ids: [], incomplete: false };
  }

  const ids: string[] = [];
  let bankerSummaryStarted = false;
  const maxIndex = Math.max(...byIndex.keys());
  for (let index = 1; index <= maxIndex; index += 1) {
    const message = byIndex.get(index);
    if (!message) return { ids, incomplete: true };
    ids.push(message.id);
    if (/(?:^|\n)🎲\s+庄家\s+@/u.test(message.content)) {
      bankerSummaryStarted = true;
    }
    // 上线前的真实格式以“🎲 庄家”进入庄家汇总、以“走势：”作为最后一行。
    // 找到该终止标记即停止，后续任意可配置续庄文案都不属于成绩单。
    if (bankerSummaryStarted && /(?:^|\n)(?:庄家)?走势：/u.test(message.content)) {
      return { ids, incomplete: false };
    }
  }
  return { ids, incomplete: true };
}

function discoverIndexedMessageIds(
  messages: Array<{ id: string }>,
  prefix: string,
): { ids: string[]; incomplete: boolean } {
  const byIndex = new Map<number, string>();
  for (const message of messages) {
    const suffix = message.id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    byIndex.set(Number(suffix), message.id);
  }
  if (!byIndex.has(0)) {
    return { ids: [], incomplete: byIndex.size > 0 };
  }
  const maxIndex = Math.max(...byIndex.keys());
  const ids: string[] = [];
  for (let index = 0; index <= maxIndex; index += 1) {
    const id = byIndex.get(index);
    if (!id) return { ids, incomplete: true };
    ids.push(id);
  }
  return { ids, incomplete: false };
}

class ScoreboardSyncSupersededError extends Error {
  constructor() {
    super('SCOREBOARD_SYNC_SUPERSEDED');
  }
}

class ScoreboardMessageExpiredError extends Error {
  constructor() {
    super('原成绩单消息不完整或已超过聊天保留期，无法原位更新');
  }
}

async function commitSyncResult(params: {
  scoreboard: {
    id: string;
    roundId: string;
    presentationRevision: number;
    presentationUpdatedBy: string | null;
    presentationSyncStatus: ScoreboardSyncStatus;
    presentationSyncedAt: Date | null;
  };
  actorId?: string;
  status: ScoreboardSyncStatus;
  error?: string | null;
  messageIds?: string[];
  lease?: ScoreboardSyncLease;
  expectedStatus?: ScoreboardSyncStatus;
}) {
  const actorId =
    params.actorId
    ?? params.scoreboard.presentationUpdatedBy
    ?? 'system';
  await params.lease?.assertHeld();
  await prisma.$transaction(async (tx) => {
    const updated = await tx.roundScoreboard.updateMany({
      where: {
        id: params.scoreboard.id,
        presentationRevision: params.scoreboard.presentationRevision,
        presentationSyncStatus: params.scoreboard.presentationSyncStatus,
        presentationSyncedAt: params.scoreboard.presentationSyncedAt,
        ...(params.expectedStatus
          ? { presentationSyncStatus: params.expectedStatus }
          : {}),
      },
      data: {
        presentationSyncStatus: params.status,
        presentationSyncError: params.error ?? null,
        presentationSyncedAt:
          params.status === ScoreboardSyncStatus.SYNCED ? new Date() : null,
        ...(params.messageIds
          ? { publishedChatMessageIds: toJson(params.messageIds) }
          : {}),
      },
    });
    if (updated.count !== 1) throw new ScoreboardSyncSupersededError();
    await tx.roundEvent.create({
      data: {
        roundId: params.scoreboard.roundId,
        type:
          params.status === ScoreboardSyncStatus.SYNCED
            ? 'SCOREBOARD_PRESENTATION_SYNCED'
            : 'SCOREBOARD_PRESENTATION_SYNC_FAILED',
        actorId,
        payload: {
          revision: params.scoreboard.presentationRevision,
          status: params.status,
          error: params.error ?? null,
          messageIds: params.messageIds ?? [],
        },
      },
    });
    await tx.auditLog.create({
      data: {
        adminId: actorId,
        action: 'scoreboard_presentation_sync',
        target: params.scoreboard.roundId,
        after: {
          revision: params.scoreboard.presentationRevision,
          status: params.status,
          error: params.error ?? null,
          messageIds: params.messageIds ?? [],
        },
      },
    });
  });
}

async function preserveSupersededMessageMapping(params: {
  scoreboard: {
    roundId: string;
    presentationRevision: number;
  };
  messageIds: string[] | null;
  lease: ScoreboardSyncLease;
}) {
  if (!params.messageIds) return;
  await params.lease.assertHeld();
  await prisma.roundScoreboard.updateMany({
    where: {
      roundId: params.scoreboard.roundId,
      presentationRevision: {
        not: params.scoreboard.presentationRevision,
      },
      presentationSyncStatus: {
        in: [
          ScoreboardSyncStatus.PENDING,
          ScoreboardSyncStatus.FAILED,
        ],
      },
    },
    data: {
      publishedChatMessageIds: toJson(params.messageIds),
    },
  });
}

/**
 * 把当前展示修订同步到原成绩单消息。若 7 天聊天历史已过期，明确标记，
 * 不把历史成绩单静默追加到当前互动群。
 */
async function syncScoreboardPresentationUnlocked(
  roundId: string,
  lease: ScoreboardSyncLease,
  actorId?: string,
  expectedRevision?: number,
) {
  await lease.assertHeld();
  const scoreboard = await requireScoreboard(roundId);
  if (
    expectedRevision != null
    && scoreboard.presentationRevision !== expectedRevision
  ) {
    return scoreboardPresentationView(scoreboard);
  }
  const presentation = parseStoredScoreboardPresentation(scoreboard.presentation);
  const chunks = formatScoreboardPlainText(scoreboard, presentation);
  const mappedIds = Array.isArray(scoreboard.publishedChatMessageIds)
    ? scoreboard.publishedChatMessageIds.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  let postMutationIds: string[] | null = null;

  try {
    let candidateIds = mappedIds;
    let discoveredSequenceIncomplete = false;
    const semanticPrefix = `round:${roundId}:scoreboard:`;
    const semanticMessages = await existingChatMessagesByPrefix(
      scoreboard.round.roomId,
      semanticPrefix,
    );
    const semanticMessageIds = semanticMessages.map((message) => message.id);
    const semanticSequence = discoverIndexedMessageIds(
      semanticMessages,
      semanticPrefix,
    );
    let existingIds = await existingChatMessageIds(
      scoreboard.round.roomId,
      candidateIds,
    );

    if (!candidateIds[0] || !existingIds.includes(candidateIds[0])) {
      if (semanticSequence.ids[0]) {
        candidateIds = semanticSequence.ids;
        existingIds = semanticSequence.ids;
        discoveredSequenceIncomplete = semanticSequence.incomplete;
      } else {
        const legacyPrefix = `round:${roundId}:announce:FINISHED:`;
        const legacyMessages = await existingChatMessagesByPrefix(
          scoreboard.round.roomId,
          legacyPrefix,
        );
        const legacySequence = discoverLegacyScoreboardMessageIds(
          legacyMessages,
          legacyPrefix,
        );
        if (legacySequence.ids[0]) {
          candidateIds = legacySequence.ids;
          existingIds = legacySequence.ids;
          discoveredSequenceIncomplete = legacySequence.incomplete;
        } else if (semanticSequence.incomplete) {
          discoveredSequenceIncomplete = true;
        }
      }
    }

    if (
      discoveredSequenceIncomplete
      || !candidateIds[0]
      || !existingIds.includes(candidateIds[0])
    ) {
      const expiredError = '原成绩单消息已超过聊天保留期，无法原位更新';
      await commitSyncResult({
        scoreboard,
        actorId,
        status: ScoreboardSyncStatus.MESSAGE_EXPIRED,
        error: expiredError,
        lease,
      });
      return getScoreboardPresentation(roundId);
    }

    const existingSet = new Set(existingIds);
    const existingSegmentsToKeep = candidateIds.slice(
      0,
      Math.min(candidateIds.length, chunks.length),
    );
    if (existingSegmentsToKeep.some((messageId) => !existingSet.has(messageId))) {
      throw new ScoreboardMessageExpiredError();
    }
    postMutationIds = [...candidateIds];
    const activeIds: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      await lease.assertHeld();
      const candidateId = candidateIds[index];
      const messageId =
        candidateId && existingSet.has(candidateId)
          ? candidateId
          : semanticScoreboardMessageId(roundId, index);
      if (existingSet.has(messageId)) {
        const updated = await updateChatStrict(
          scoreboard.round.roomId,
          messageId,
          {
            type: 'SYSTEM',
            content: chunks[index]!,
          },
          lease,
        );
        if (!updated) {
          throw new ScoreboardMessageExpiredError();
        }
      } else {
        await appendChatOnce(
          scoreboard.round.roomId,
          messageId,
          {
            type: 'SYSTEM',
            content: chunks[index]!,
            from: null,
          },
          lease,
        );
      }
      postMutationIds[index] = messageId;
      activeIds.push(messageId);
    }

    const staleIds = [
      ...new Set([
        ...candidateIds.slice(chunks.length),
        ...semanticMessageIds.filter((id) => !activeIds.includes(id)),
      ]),
    ];
    for (const staleId of staleIds) {
      await lease.assertHeld();
      await deleteChatStrict(scoreboard.round.roomId, staleId, lease);
      postMutationIds = postMutationIds.filter((id) => id !== staleId);
    }
    postMutationIds = activeIds;

    await commitSyncResult({
      scoreboard,
      actorId,
      status: ScoreboardSyncStatus.SYNCED,
      messageIds: activeIds,
      lease,
    });
    return getScoreboardPresentation(roundId);
  } catch (error) {
    if (error instanceof ScoreboardSyncLockLostError) throw error;
    if (error instanceof ScoreboardSyncSupersededError) {
      await preserveSupersededMessageMapping({
        scoreboard,
        messageIds: postMutationIds,
        lease,
      });
      return getScoreboardPresentation(roundId);
    }
    if (error instanceof ScoreboardMessageExpiredError) {
      try {
        await commitSyncResult({
          scoreboard,
          actorId,
          status: ScoreboardSyncStatus.MESSAGE_EXPIRED,
          error: error.message,
          ...(postMutationIds ? { messageIds: postMutationIds } : {}),
          lease,
        });
      } catch (commitError) {
        if (commitError instanceof ScoreboardSyncSupersededError) {
          await preserveSupersededMessageMapping({
            scoreboard,
            messageIds: postMutationIds,
            lease,
          });
          return getScoreboardPresentation(roundId);
        }
        throw commitError;
      }
      return getScoreboardPresentation(roundId);
    }
    const message = error instanceof Error ? error.message : '未知同步错误';
    try {
      await commitSyncResult({
        scoreboard,
        actorId,
        status: ScoreboardSyncStatus.FAILED,
        error: message.slice(0, 500),
        ...(postMutationIds ? { messageIds: postMutationIds } : {}),
        lease,
      });
    } catch (commitError) {
      if (commitError instanceof ScoreboardSyncSupersededError) {
        await preserveSupersededMessageMapping({
          scoreboard,
          messageIds: postMutationIds,
          lease,
        });
        return getScoreboardPresentation(roundId);
      }
      throw commitError;
    }
    throw new ScoreboardPresentationError('SCOREBOARD_SYNC_FAILED', 503);
  }
}

export function syncScoreboardPresentation(roundId: string, actorId?: string) {
  return withScoreboardSyncLock(roundId, (lease) =>
    syncScoreboardPresentationUnlocked(roundId, lease, actorId),
  ).catch((error) => {
    if (
      error instanceof ScoreboardSyncLockUnavailableError
      || error instanceof ScoreboardSyncLockLostError
    ) {
      throw new ScoreboardPresentationError('SCOREBOARD_SYNC_FAILED', 503);
    }
    throw error;
  });
}

export async function saveAndSyncScoreboardPresentation(params: {
  roundId: string;
  adminId: string;
  ip?: string;
  input: ScoreboardPresentationMutation;
}) {
  const saved = await saveScoreboardPresentation(params);
  try {
    return await withScoreboardSyncLock(params.roundId, (lease) =>
      syncScoreboardPresentationUnlocked(
        params.roundId,
        lease,
        params.adminId,
        saved.presentationRevision,
      ),
    );
  } catch (error) {
    if (
      error instanceof ScoreboardSyncLockUnavailableError
      || error instanceof ScoreboardSyncLockLostError
    ) {
      try {
        await commitSyncResult({
          scoreboard: saved,
          actorId: params.adminId,
          status: ScoreboardSyncStatus.FAILED,
          error: error.message,
          expectedStatus: ScoreboardSyncStatus.PENDING,
        });
      } catch (commitError) {
        if (commitError instanceof ScoreboardSyncSupersededError) {
          return getScoreboardPresentation(params.roundId);
        }
      }
      throw new ScoreboardPresentationError('SCOREBOARD_SYNC_FAILED', 503);
    }
    throw error;
  }
}

export async function restoreAndSyncScoreboardPresentation(params: {
  roundId: string;
  revision: number;
  expectedRevision: number;
  reason: string;
  adminId: string;
  ip?: string;
}) {
  const saved = await restoreScoreboardPresentation(params);
  try {
    return await withScoreboardSyncLock(params.roundId, (lease) =>
      syncScoreboardPresentationUnlocked(
        params.roundId,
        lease,
        params.adminId,
        saved.presentationRevision,
      ),
    );
  } catch (error) {
    if (
      error instanceof ScoreboardSyncLockUnavailableError
      || error instanceof ScoreboardSyncLockLostError
    ) {
      try {
        await commitSyncResult({
          scoreboard: saved,
          actorId: params.adminId,
          status: ScoreboardSyncStatus.FAILED,
          error: error.message,
          expectedStatus: ScoreboardSyncStatus.PENDING,
        });
      } catch (commitError) {
        if (commitError instanceof ScoreboardSyncSupersededError) {
          return getScoreboardPresentation(params.roundId);
        }
      }
      throw new ScoreboardPresentationError('SCOREBOARD_SYNC_FAILED', 503);
    }
    throw error;
  }
}

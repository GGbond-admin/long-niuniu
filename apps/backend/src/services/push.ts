/**
 * 推送服务：业务事件 → Bot 私聊（后台模板可配，见 03 文档推送中心）
 */
import { Bot } from 'grammy';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../config.js';
import { decryptSecret } from '../lib/crypto.js';

const bots = new Map<string, Bot>();

async function botFor(userId: string, preferredBotId?: string): Promise<{ bot: Bot; tgId: bigint } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  // 虚拟玩家无 Telegram，跳过私聊推送。
  if (!user?.tgId) return null;

  let token: string | null = null;
  let botKey = 'default';
  const routedBotId = preferredBotId ?? user.lastBotId;
  if (routedBotId) {
    const row = await prisma.telegramBot.findUnique({ where: { id: routedBotId } });
    if (row && row.status === 'ACTIVE') {
      token = decryptSecret(row.token);
      botKey = row.id;
    }
  }
  if (!token) {
    const def = await prisma.telegramBot.findFirst({ where: { isDefault: true, status: 'ACTIVE' } });
    if (def) {
      token = decryptSecret(def.token);
      botKey = def.id;
    } else if (env.defaultBotToken) {
      token = env.defaultBotToken;
    }
  }
  if (!token) return null;

  let bot = bots.get(botKey);
  if (!bot) {
    bot = new Bot(token);
    bots.set(botKey, bot);
  }
  return { bot, tgId: user.tgId };
}

async function renderTemplate(code: string, fallback: string, vars: Record<string, string>): Promise<string> {
  const tpl = await prisma.pushTemplate.findUnique({ where: { code } });
  let body = tpl?.body ?? fallback;
  for (const [k, v] of Object.entries(vars)) {
    body = body.replaceAll(`{{${k}}}`, v);
  }
  return body;
}

async function sendToUser(
  userId: string,
  text: string,
  preferredBotId?: string,
): Promise<{ success: boolean; messageId?: bigint; error?: string }> {
  try {
    const target = await botFor(userId, preferredBotId);
    if (!target) return { success: false, error: 'NO_BOT_ROUTE' };
    const message = await target.bot.api.sendMessage(Number(target.tgId), text);
    return { success: true, messageId: BigInt(message.message_id) };
  } catch (error) {
    return { success: false, error: (error as Error).message.slice(0, 500) };
  }
}

export class PushService {
  clearBotCache() {
    bots.clear();
  }

  async notifyKycSubmitted(userId: string) {
    const text = await renderTemplate(
      'kyc_submitted',
      '🪪 实名认证已提交\n\n您的资料已成功提交，正在等待审核。\n通常会在 1-3 个工作日内完成，最快几小时内就会通过。\n审核结果将通过此处通知。',
      {},
    );
    return (await sendToUser(userId, text)).success;
  }

  async notifyKycApproved(userId: string) {
    const text = await renderTemplate(
      'kyc_approved',
      '✅ 实名认证已通过\n\n现在可以正常使用钱包和消息功能了。\n请重新打开小程序，或点右上角重新加载页面即可。',
      {},
    );
    return (await sendToUser(userId, text)).success;
  }

  async notifyKycRejected(userId: string, reason: string) {
    const text = await renderTemplate(
      'kyc_rejected',
      '❌ 实名认证未通过\n\n原因：{{reason}}\n请修改资料后重新提交。',
      { reason },
    );
    return (await sendToUser(userId, text)).success;
  }

  async notifyRewardGranted(userId: string, title: string, amount: string) {
    const text = await renderTemplate(
      'reward_granted',
      '🎉 恭喜！\n获得{{title}}奖励 {{amount}}',
      { title, amount },
    );
    return (await sendToUser(userId, text)).success;
  }

  async notifyDepositCompleted(userId: string, amount: string) {
    const text = await renderTemplate(
      'deposit_completed',
      '✅ 充值已到账\n{{amount}} 已加入您的可用余额。',
      { amount },
    );
    return (await sendToUser(userId, text)).success;
  }

  async notifyWithdrawCompleted(userId: string, amount: string) {
    const text = await renderTemplate(
      'withdraw_completed',
      '✅ 提现已完成\n财务已处理 {{amount}}，请检查您的收款账户。',
      { amount },
    );
    return (await sendToUser(userId, text)).success;
  }

  async notifyOrderRejected(
    userId: string,
    kind: '充值' | '提现',
    amount: string,
    reason: string,
  ) {
    const text = await renderTemplate(
      'order_rejected',
      '❌ {{kind}}申请已驳回\n金额：{{amount}}\n原因：{{reason}}',
      { kind, amount, reason },
    );
    return (await sendToUser(userId, text)).success;
  }

  async sendCustom(userId: string, text: string) {
    return (await sendToUser(userId, text)).success;
  }

  async executeJob(jobId: string) {
    const claimed = await prisma.pushJob.updateMany({
      where: { id: jobId, status: { in: ['PENDING', 'FAILED', 'PARTIAL'] } },
      data: { status: 'PROCESSING' },
    });
    if (claimed.count !== 1) return null;
    const job = await prisma.pushJob.findUnique({
      where: { id: jobId },
      include: { template: true },
    });
    if (!job) return null;
    try {
      const audience = job.audience as {
        type?: string;
        uids?: string[];
        roomId?: string;
      };
      const payload = job.payload as Record<string, unknown>;
      let where: Prisma.UserWhereInput;
      if (audience.type === 'uids') {
        where = { uid: { in: audience.uids ?? [] }, status: 'ACTIVE' };
      } else if (audience.type === 'kyc_approved') {
        where = { status: 'ACTIVE', kyc: { status: 'APPROVED' } };
      } else if (audience.type === 'room' && audience.roomId) {
        where = {
          status: 'ACTIVE',
          roomMemberships: {
            some: {
              roomId: audience.roomId,
              status: 'ACTIVE',
            },
          },
        };
      } else if (audience.type === 'all') {
        where = { status: 'ACTIVE' };
      } else {
        // 历史脏任务或未知受众必须明确失败，不能伪装成零收件人的成功任务。
        throw new Error('INVALID_PUSH_AUDIENCE');
      }
      const users = await prisma.user.findMany({ where, select: { id: true } });
      let body =
        typeof payload.__templateBody === 'string'
          ? payload.__templateBody
          : job.template?.body ?? String(payload.body ?? '');
      for (const [key, value] of Object.entries(payload)) {
        if (key.startsWith('__')) continue;
        body = body.replaceAll(`{{${key}}}`, String(value));
      }
      let successCount = 0;
      for (const user of users) {
        const existing = await prisma.pushLog.findFirst({
          where: { jobId: job.id, userId: user.id, success: true },
        });
        if (existing) {
          successCount += 1;
          continue;
        }
        const result = await sendToUser(user.id, body, job.botId ?? undefined);
        await prisma.pushLog.create({
          data: {
            jobId: job.id,
            userId: user.id,
            success: result.success,
            error: result.error,
            messageId: result.messageId,
          },
        });
        if (result.success) successCount += 1;
      }
      const status =
        users.length === 0 || successCount === users.length
          ? 'SENT'
          : successCount > 0
            ? 'PARTIAL'
            : 'FAILED';
      await prisma.pushJob.update({ where: { id: job.id }, data: { status } });
      return { status, total: users.length, success: successCount };
    } catch (error) {
      await prisma.pushJob
        .update({ where: { id: job.id }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      throw error;
    }
  }

  async processDueJobs(limit = 20) {
    const jobs = await prisma.pushJob.findMany({
      where: {
        status: 'PENDING',
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    for (const job of jobs) await this.executeJob(job.id);
    return jobs.length;
  }
}

export const pushService = new PushService();

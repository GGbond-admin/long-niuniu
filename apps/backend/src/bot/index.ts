/**
 * Telegram Bot（grammY）：仅负责入口与菜单。
 * - /start 深链欢迎 +「进入游戏厅」菜单按钮
 * - 实名/奖励/充提等推送由 services/push.ts 走私聊，不在此处理
 * 对局（竞庄/下注/抢包/成绩单）全部在 Mini App 网页游戏房完成，不再解析群指令或禁言。
 */
import { Bot, InlineKeyboard } from 'grammy';
import { env } from '../config.js';
import { decryptSecret } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { parseRefParam } from '../lib/telegram.js';

function miniappUrl(botUsername: string, refUid?: string | null): string {
  const url = new URL(env.miniappUrl);
  if (botUsername) url.searchParams.set('bot', botUsername.replace(/^@/, ''));
  if (refUid) url.searchParams.set('ref', refUid);
  return url.toString();
}

let managedBots: Bot[] = [];
let botOperation: Promise<void> = Promise.resolve();

async function startBotsInternal(): Promise<Bot[]> {
  if (managedBots.length > 0) return managedBots;
  const rows = await prisma.telegramBot.findMany({ where: { status: 'ACTIVE' } });
  const configs: Array<{ id: string; token: string; username: string }> = [];
  for (const row of rows) {
    try {
      configs.push({
        id: row.id,
        token: decryptSecret(row.token),
        username: row.username,
      });
    } catch (error) {
      console.error(
        `[bot:${row.username || row.id}] skipped (token decrypt failed):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (!configs.length && env.defaultBotToken) {
    configs.push({
      id: 'env-default',
      token: env.defaultBotToken,
      username: env.defaultBotUsername,
    });
  }

  const bots: Bot[] = [];
  for (const cfg of configs) {
    try {
      await new Bot(cfg.token).api.getMe();
    } catch (error) {
      console.error(
        `[bot:${cfg.username || cfg.id}] skipped (invalid token):`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }
    const bot = new Bot(cfg.token);

    bot.command('start', async (ctx) => {
      const refUid = parseRefParam(ctx.match);
      const keyboard = new InlineKeyboard().webApp(
        '进入游戏厅',
        miniappUrl(cfg.username, refUid),
      );
      await ctx.reply(
        '欢迎来到 至尊牛牛\n\n💡 点击下方按钮打开游戏大厅\n进入「至尊牛牛互动群」参与对局（竞庄、下注、抢包、成绩单）。',
        { reply_markup: keyboard },
      );
    });

    try {
      await bot.api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: '进入游戏厅',
          web_app: { url: miniappUrl(cfg.username) },
        },
      });
    } catch {
      // URL 尚未使用 HTTPS 或 BotFather 未允许域名时保留命令入口。
    }

    void bot
      .start({
        drop_pending_updates: true,
        allowed_updates: ['message'],
        onStart: () => console.log(`[bot] started (entry/notify only): @${cfg.username || cfg.id}`),
      })
      .catch((error) => {
        console.error(`[bot:${cfg.username || cfg.id}] polling stopped`, error);
      });
    bots.push(bot);
  }
  managedBots = bots;
  return managedBots;
}

async function stopBotsInternal(): Promise<void> {
  const bots = managedBots;
  managedBots = [];
  for (const bot of bots) {
    await bot.stop().catch(() => undefined);
  }
}

function queueBotOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = botOperation.then(operation, operation);
  botOperation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function startBots(): Promise<Bot[]> {
  return queueBotOperation(startBotsInternal);
}

export function reloadBots(): Promise<Bot[]> {
  return queueBotOperation(async () => {
    await stopBotsInternal();
    return startBotsInternal();
  });
}

export function stopBots(): Promise<void> {
  return queueBotOperation(stopBotsInternal);
}

export async function validateBotCredentials(token: string, expectedUsername?: string) {
  const info = await new Bot(token).api.getMe();
  if (
    expectedUsername &&
    info.username.toLowerCase() !== expectedUsername.replace(/^@/, '').toLowerCase()
  ) {
    throw new Error('BOT_USERNAME_MISMATCH');
  }
  return info;
}

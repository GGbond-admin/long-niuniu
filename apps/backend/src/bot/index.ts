/**
 * Telegram Bot（grammY）：仅负责入口与菜单。
 * - /start 深链欢迎 +「进入游戏厅」菜单按钮
 * - 实名/奖励/充提等推送由 services/push.ts 走私聊，不在此处理
 * 对局（竞庄/下注/抢包/成绩单）全部在 Mini App 网页游戏房完成，不再解析群指令或禁言。
 */
import { randomUUID } from 'node:crypto';
import { AbortController } from 'abort-controller';
import { Bot, InlineKeyboard } from 'grammy';
import { env } from '../config.js';
import { decryptSecret } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { parseRefParam } from '../lib/telegram.js';

function miniappUrl(botUsername: string, refUid?: string | null): string {
  const url = new URL(env.miniappUrl);
  if (botUsername) url.searchParams.set('bot', botUsername.replace(/^@/, ''));
  if (refUid) url.searchParams.set('ref', refUid);
  return url.toString();
}

let managedBots: Bot[] = [];
const startingBots = new Set<Bot>();
let botOperation: Promise<void> = Promise.resolve();
let managedConfigSignature = '';
let botLeaseToken: string | null = null;
let botLeaseRenewTimer: ReturnType<typeof setInterval> | null = null;
let botLeaseRetryTimer: ReturnType<typeof setTimeout> | null = null;
let botConfigWatchTimer: ReturnType<typeof setInterval> | null = null;
let botConfigRefreshRunning = false;
let botManagerStopped = false;
let botManagerGeneration = 0;
let botLeaseExpiresAt = 0;
let botLeaseNextRenewAt = 0;
let botLeaseRenewInFlight = false;

const BOT_LEASE_KEY = 'locks:telegram-bot-polling';
const BOT_LEASE_TTL_MS = 30_000;
const BOT_LEASE_RENEW_MS = 10_000;
const BOT_LEASE_TICK_MS = 1_000;
const BOT_LEASE_SAFETY_MS = 2_000;
const BOT_LEASE_RETRY_MS = 10_000;
const BOT_CONFIG_WATCH_MS = 30_000;
const BOT_START_API_TIMEOUT_MS = 15_000;

async function loadBotConfigs() {
  const rows = await prisma.telegramBot.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { id: 'asc' },
  });
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
  return {
    configs,
    signature: JSON.stringify(
      rows.length
        ? rows.map((row) => [row.id, row.username, row.token])
        : configs.map((config) => [config.id, config.username, config.token]),
    ),
  };
}

function botStartAbort() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOT_START_API_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.aborted,
    clear: () => clearTimeout(timer),
  };
}

function clearBotLeaseRetry() {
  if (!botLeaseRetryTimer) return;
  clearTimeout(botLeaseRetryTimer);
  botLeaseRetryTimer = null;
}

function scheduleBotLeaseRetry() {
  if (botManagerStopped || botLeaseToken || botLeaseRetryTimer) return;
  const generation = botManagerGeneration;
  botLeaseRetryTimer = setTimeout(() => {
    botLeaseRetryTimer = null;
    if (botManagerStopped || generation !== botManagerGeneration) return;
    void queueBotOperation(() => startBotsInternal(generation))
      .catch((error) => {
        console.error('[bot] standby lease retry failed', error);
      })
      .finally(scheduleBotLeaseRetry);
  }, BOT_LEASE_RETRY_MS);
  botLeaseRetryTimer.unref?.();
}

function clearBotConfigWatch() {
  if (!botConfigWatchTimer) return;
  clearInterval(botConfigWatchTimer);
  botConfigWatchTimer = null;
}

function startBotConfigWatch() {
  if (botConfigWatchTimer || !botLeaseToken) return;
  const generation = botManagerGeneration;
  botConfigWatchTimer = setInterval(() => {
    if (
      botManagerStopped
      || generation !== botManagerGeneration
      || botConfigRefreshRunning
      || !botLeaseToken
    ) return;
    botConfigRefreshRunning = true;
    void loadBotConfigs()
      .then(({ signature }) => {
        if (
          signature === managedConfigSignature
          || botManagerStopped
          || generation !== botManagerGeneration
          || !botLeaseToken
        ) return;
        return queueBotOperation(async () => {
          if (
            botManagerStopped
            || generation !== botManagerGeneration
            || !botLeaseToken
          ) return;
          await stopManagedBots();
          await startBotsInternal(generation);
        });
      })
      .catch((error) => console.error('[bot] config refresh failed', error))
      .finally(() => {
        botConfigRefreshRunning = false;
      });
  }, BOT_CONFIG_WATCH_MS);
  botConfigWatchTimer.unref?.();
}

async function handleBotLeaseLoss() {
  if (!botLeaseToken) return;
  botLeaseToken = null;
  botLeaseExpiresAt = 0;
  botLeaseNextRenewAt = 0;
  botLeaseRenewInFlight = false;
  if (botLeaseRenewTimer) {
    clearInterval(botLeaseRenewTimer);
    botLeaseRenewTimer = null;
  }
  clearBotConfigWatch();
  await stopBotInstances(takeKnownBotInstances());
  scheduleBotLeaseRetry();
}

async function acquireBotLease(): Promise<boolean> {
  if (botLeaseToken) return true;
  const token = `${process.pid}:${randomUUID()}`;
  try {
    const acquired = await redis().set(BOT_LEASE_KEY, token, 'PX', BOT_LEASE_TTL_MS, 'NX');
    if (acquired !== 'OK') {
      scheduleBotLeaseRetry();
      return false;
    }
  } catch (error) {
    if (env.nodeEnv === 'production') {
      console.error('[bot] polling lease unavailable; staying in standby', error);
      scheduleBotLeaseRetry();
      return false;
    }
    // 本地单实例允许无 Redis 运行；生产环境必须 fail-closed，避免多个副本同时长轮询。
    botLeaseToken = `local:${token}`;
    return true;
  }

  botLeaseToken = token;
  const acquiredAt = Date.now();
  botLeaseExpiresAt = acquiredAt + BOT_LEASE_TTL_MS;
  botLeaseNextRenewAt = acquiredAt + BOT_LEASE_RENEW_MS;
  botLeaseRenewInFlight = false;
  clearBotLeaseRetry();
  botLeaseRenewTimer = setInterval(() => {
    if (!botLeaseToken || botLeaseToken.startsWith('local:')) return;
    const expected = botLeaseToken;
    const now = Date.now();
    if (now >= botLeaseExpiresAt - BOT_LEASE_SAFETY_MS) {
      void handleBotLeaseLoss();
      return;
    }
    if (botLeaseRenewInFlight || now < botLeaseNextRenewAt) return;
    botLeaseRenewInFlight = true;
    void redis()
      .eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
        1,
        BOT_LEASE_KEY,
        expected,
        BOT_LEASE_TTL_MS,
      )
      .then((renewed) => {
        if (botLeaseToken !== expected) return;
        if (Number(renewed) !== 1) return handleBotLeaseLoss();
        const renewedAt = Date.now();
        botLeaseExpiresAt = renewedAt + BOT_LEASE_TTL_MS;
        botLeaseNextRenewAt = renewedAt + BOT_LEASE_RENEW_MS;
      })
      .catch(() => {
        if (botLeaseToken === expected) return handleBotLeaseLoss();
      })
      .finally(() => {
        if (botLeaseToken === expected) botLeaseRenewInFlight = false;
      });
  }, BOT_LEASE_TICK_MS);
  botLeaseRenewTimer.unref?.();
  return true;
}

async function releaseBotLease() {
  const token = botLeaseToken;
  botLeaseToken = null;
  botLeaseExpiresAt = 0;
  botLeaseNextRenewAt = 0;
  botLeaseRenewInFlight = false;
  if (botLeaseRenewTimer) {
    clearInterval(botLeaseRenewTimer);
    botLeaseRenewTimer = null;
  }
  clearBotConfigWatch();
  clearBotLeaseRetry();
  if (!token || token.startsWith('local:')) return;
  await redis()
    .eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      BOT_LEASE_KEY,
      token,
    )
    .catch(() => undefined);
}

function botStartIsCurrent(token: string | null, generation: number): boolean {
  return Boolean(
    token
    && token === botLeaseToken
    && !botManagerStopped
    && generation === botManagerGeneration,
  );
}

async function stopBotInstances(bots: Bot[]): Promise<void> {
  await Promise.allSettled(bots.map((bot) => bot.stop()));
}

async function discardStartingBotInstances(bots: Bot[]): Promise<void> {
  const unique = [...new Set(bots)];
  for (const bot of unique) startingBots.delete(bot);
  await stopBotInstances(unique);
}

function takeKnownBotInstances(): Bot[] {
  const bots = [...new Set([...managedBots, ...startingBots])];
  managedBots = [];
  startingBots.clear();
  return bots;
}

async function startBotsInternal(
  generation = botManagerGeneration,
): Promise<Bot[]> {
  if (botManagerStopped || generation !== botManagerGeneration) return [];
  if (managedBots.length > 0) return managedBots;
  if (!(await acquireBotLease())) return [];
  const leaseToken = botLeaseToken;
  const bots: Bot[] = [];

  try {
    if (!botStartIsCurrent(leaseToken, generation)) {
      if (botLeaseToken === leaseToken) await releaseBotLease();
      return [];
    }
    const { configs, signature } = await loadBotConfigs();
    if (!botStartIsCurrent(leaseToken, generation)) {
      if (botLeaseToken === leaseToken) await releaseBotLease();
      return [];
    }
    managedConfigSignature = signature;

    for (const cfg of configs) {
      const credentialAbort = botStartAbort();
      try {
        await new Bot(cfg.token).api.getMe(credentialAbort.signal);
      } catch (error) {
        if (!botStartIsCurrent(leaseToken, generation)) {
          await discardStartingBotInstances(bots);
          return [];
        }
        if (credentialAbort.timedOut()) {
          throw new Error('BOT_START_API_TIMEOUT', { cause: error });
        }
        console.error(
          `[bot:${cfg.username || cfg.id}] skipped (invalid token):`,
          error instanceof Error ? error.message : error,
        );
        continue;
      } finally {
        credentialAbort.clear();
      }
      if (!botStartIsCurrent(leaseToken, generation)) {
        await discardStartingBotInstances(bots);
        return [];
      }
      const bot = new Bot(cfg.token);
      startingBots.add(bot);

      bot.command('start', async (ctx) => {
        const refUid = parseRefParam(ctx.match);
        const keyboard = new InlineKeyboard().webApp(
          '进入游戏厅',
          miniappUrl(cfg.username, refUid),
        );
        await ctx.reply(
          '👋欢迎来到至尊牛牛\n\n💡点击下方按钮打开游戏大厅\n进入至尊牛牛互动群参与对局（竞庄、下注、抢包、成绩单）。',
          { reply_markup: keyboard },
        );
      });

      const menuAbort = botStartAbort();
      try {
        await bot.api.setChatMenuButton(
          {
            menu_button: {
              type: 'web_app',
              text: '进入游戏厅',
              web_app: { url: miniappUrl(cfg.username) },
            },
          },
          menuAbort.signal,
        );
      } catch {
        // URL 尚未使用 HTTPS 或 BotFather 未允许域名时保留命令入口。
      } finally {
        menuAbort.clear();
      }
      if (!botStartIsCurrent(leaseToken, generation)) {
        await discardStartingBotInstances([...bots, bot]);
        return [];
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
    if (!botStartIsCurrent(leaseToken, generation)) {
      await discardStartingBotInstances(bots);
      return [];
    }
    for (const bot of bots) startingBots.delete(bot);
    managedBots = bots;
    startBotConfigWatch();
    return managedBots;
  } catch (error) {
    const partialBots = [...new Set([...bots, ...startingBots])];
    await discardStartingBotInstances(partialBots);
    if (botLeaseToken === leaseToken) await releaseBotLease();
    if (!botManagerStopped && generation === botManagerGeneration) {
      scheduleBotLeaseRetry();
    }
    throw error;
  }
}

async function stopManagedBots(): Promise<void> {
  const bots = managedBots;
  managedBots = [];
  await stopBotInstances(bots);
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
  if (botManagerStopped || botManagerGeneration === 0) {
    botManagerStopped = false;
    botManagerGeneration += 1;
  }
  const generation = botManagerGeneration;
  return queueBotOperation(() => startBotsInternal(generation));
}

export function reloadBots(): Promise<Bot[]> {
  const generation = botManagerGeneration;
  return queueBotOperation(async () => {
    if (botManagerStopped || generation !== botManagerGeneration) return [];
    await stopManagedBots();
    return startBotsInternal(generation);
  });
}

export function stopBots(): Promise<void> {
  botManagerStopped = true;
  botManagerGeneration += 1;
  clearBotLeaseRetry();
  clearBotConfigWatch();
  const interruptedStop = stopBotInstances(takeKnownBotInstances());
  return queueBotOperation(async () => {
    await interruptedStop;
    await stopManagedBots();
    await releaseBotLease();
  });
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

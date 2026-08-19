import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
  getMe: vi.fn(),
  setChatMenuButton: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../config.js', () => ({
  env: {
    nodeEnv: 'production',
    miniappUrl: 'https://example.com',
    defaultBotToken: '',
    defaultBotUsername: '',
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    telegramBot: {
      findMany: mocks.findMany,
    },
  },
}));

vi.mock('../lib/crypto.js', () => ({
  decryptSecret: () => 'plain-token',
}));

vi.mock('../lib/redis.js', () => ({
  redis: () => ({
    set: mocks.redisSet,
    eval: mocks.redisEval,
  }),
}));

vi.mock('grammy', () => {
  class Bot {
    api = {
      getMe: mocks.getMe,
      setChatMenuButton: mocks.setChatMenuButton,
    };

    command() {
      return undefined;
    }

    start(options: unknown) {
      return mocks.start(options);
    }

    stop() {
      return mocks.stop();
    }
  }

  class InlineKeyboard {
    webApp() {
      return this;
    }
  }

  return { Bot, InlineKeyboard };
});

import { startBots, stopBots } from './index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Telegram bot polling lease', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([
      {
        id: 'bot-1',
        username: 'niuniu_bot',
        token: 'encrypted-token',
        status: 'ACTIVE',
      },
    ]);
    mocks.redisEval.mockResolvedValue(1);
    mocks.getMe.mockResolvedValue({ username: 'niuniu_bot' });
    mocks.setChatMenuButton.mockResolvedValue(undefined);
    mocks.start.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await stopBots();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts long polling only after acquiring the distributed lease', async () => {
    mocks.redisSet.mockResolvedValue('OK');

    const bots = await startBots();

    expect(bots).toHaveLength(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.redisSet).toHaveBeenCalledWith(
      'locks:telegram-bot-polling',
      expect.any(String),
      'PX',
      30_000,
      'NX',
    );
  });

  it('stays in standby when another instance owns the lease', async () => {
    mocks.redisSet.mockResolvedValue(null);

    const bots = await startBots();

    expect(bots).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('releases the lease when configuration loading fails after acquisition', async () => {
    mocks.redisSet.mockResolvedValue('OK');
    mocks.findMany.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(startBots()).rejects.toThrow('database unavailable');

    expect(mocks.redisEval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del"'),
      1,
      'locks:telegram-bot-polling',
      expect.any(String),
    );
  });

  it('does not restart after the manager has entered the stopped state', async () => {
    await stopBots();
    vi.clearAllMocks();
    mocks.redisSet.mockResolvedValue('OK');

    const bots = await import('./index.js').then(({ reloadBots }) => reloadBots());

    expect(bots).toEqual([]);
    expect(mocks.redisSet).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('stops before the local lease deadline when a renewal never settles', async () => {
    vi.useFakeTimers();
    mocks.redisSet.mockResolvedValue('OK');
    const renewal = deferred<number>();
    mocks.redisEval.mockImplementation(() => renewal.promise);

    await startBots();
    await vi.advanceTimersByTimeAsync(29_000);

    expect(mocks.redisEval).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);

    mocks.redisEval.mockResolvedValue(1);
  });

  it('does not begin polling when the lease is lost during credential validation', async () => {
    vi.useFakeTimers();
    mocks.redisSet.mockResolvedValue('OK');
    const credentials = deferred<{ username: string }>();
    mocks.getMe.mockReturnValueOnce(credentials.promise);
    mocks.redisEval.mockResolvedValueOnce(0);

    const starting = startBots();
    await vi.advanceTimersByTimeAsync(10_000);
    credentials.resolve({ username: 'niuniu_bot' });
    await starting;

    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('immediately stops a partially started bot when a later credential check hangs', async () => {
    vi.useFakeTimers();
    mocks.findMany.mockResolvedValue([
      {
        id: 'bot-1',
        username: 'niuniu_bot_1',
        token: 'encrypted-token-1',
        status: 'ACTIVE',
      },
      {
        id: 'bot-2',
        username: 'niuniu_bot_2',
        token: 'encrypted-token-2',
        status: 'ACTIVE',
      },
    ]);
    mocks.redisSet.mockResolvedValue('OK');
    const secondCredentials = deferred<{ username: string }>();
    mocks.getMe
      .mockResolvedValueOnce({ username: 'niuniu_bot_1' })
      .mockReturnValueOnce(secondCredentials.promise);
    mocks.redisEval.mockResolvedValueOnce(0);

    const starting = startBots();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);

    secondCredentials.resolve({ username: 'niuniu_bot_2' });
    await starting;
  });

  it('aborts a timed-out credential request before scheduling a retry', async () => {
    vi.useFakeTimers();
    mocks.redisSet.mockResolvedValue('OK');
    mocks.getMe.mockImplementationOnce(
      (signal?: {
        addEventListener: (
          type: string,
          listener: () => void,
          options?: { once?: boolean },
        ) => void;
      }) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );

    const starting = startBots();
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(starting).rejects.toThrow('BOT_START_API_TIMEOUT');
    expect(mocks.redisEval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del"'),
      1,
      'locks:telegram-bot-polling',
      expect.any(String),
    );
  });

  it('signals every managed bot to stop without waiting for an earlier one', async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: 'bot-1',
        username: 'niuniu_bot_1',
        token: 'encrypted-token-1',
        status: 'ACTIVE',
      },
      {
        id: 'bot-2',
        username: 'niuniu_bot_2',
        token: 'encrypted-token-2',
        status: 'ACTIVE',
      },
    ]);
    mocks.redisSet.mockResolvedValue('OK');
    await startBots();
    mocks.stop.mockClear();
    const firstStop = deferred<void>();
    mocks.stop
      .mockReturnValueOnce(firstStop.promise)
      .mockResolvedValueOnce(undefined);

    const stopping = stopBots();

    expect(mocks.stop).toHaveBeenCalledTimes(2);
    firstStop.resolve();
    await stopping;
  });
});

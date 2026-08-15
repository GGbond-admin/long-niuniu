import { generateAllLeaderboards } from './leaderboards.js';
import { autoSettleProfitPool } from './profitPool.js';
import { pushService } from './push.js';
import { previousMalaysiaDay, settleRebates } from './rebates.js';
import { withRedisLock } from '../lib/redis.js';
import { SUPPORTED_GAME_CODES } from './gameCatalog.js';
import { reconcileVpayDeposits } from './vpayDeposits.js';

export class BackgroundJobs {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastLeaderboardRun = 0;

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await withRedisLock('niuniu:background-jobs:tick', 55_000, async () => {
        await pushService.processDueJobs();
        await settleRebates(previousMalaysiaDay());
        // 返水结算后再结利润池，保证当日流水/抽水口径完整。
        await autoSettleProfitPool(previousMalaysiaDay());
        await reconcileVpayDeposits();
        if (Date.now() - this.lastLeaderboardRun > 5 * 60_000) {
          for (const gameCode of SUPPORTED_GAME_CODES) {
            await generateAllLeaderboards(gameCode);
          }
          this.lastLeaderboardRun = Date.now();
        }
      });
    } catch (error) {
      console.error('[jobs] background job failed', error);
    } finally {
      this.running = false;
    }
  }
}

export const backgroundJobs = new BackgroundJobs();

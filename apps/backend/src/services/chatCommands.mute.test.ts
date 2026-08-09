import { RoundPhase } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { isChatMuted } from './chatCommands.js';

describe('互动群发言禁言', () => {
  it('仅抢包进行中禁言，等待成绩单与结算中可发言', () => {
    expect(isChatMuted(RoundPhase.CLAIMING)).toBe(true);
    expect(isChatMuted(RoundPhase.CLAIM_EXPIRED)).toBe(false);
    expect(isChatMuted(RoundPhase.SETTLING)).toBe(false);
    expect(isChatMuted(RoundPhase.BETTING)).toBe(false);
  });
});

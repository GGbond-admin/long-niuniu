import { describe, expect, it } from 'vitest';
import { nextWaitingSeqNo } from '../engine/roundSeq.js';

describe('无效局复用局号', () => {
  it('没有有效局时从第 1 局开始', () => {
    expect(nextWaitingSeqNo(null)).toBe(1);
    expect(nextWaitingSeqNo(undefined)).toBe(1);
    expect(nextWaitingSeqNo(0)).toBe(1);
  });

  it('第 18 局无效后下一局仍是 18，而不是 19', () => {
    expect(nextWaitingSeqNo(17)).toBe(18);
  });

  it('有效局完成后才进入下一号', () => {
    expect(nextWaitingSeqNo(18)).toBe(19);
  });
});

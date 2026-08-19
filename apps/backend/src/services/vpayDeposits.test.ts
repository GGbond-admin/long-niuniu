import { beforeEach, describe, expect, it, vi } from 'vitest';

type OrderRow = {
  id: string;
  userId: string;
  amountCents: bigint;
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  channel: 'MANUAL' | 'VPAY';
  paidAmountCents?: bigint | null;
  creditedAmountCents?: bigint | null;
  providerTradeNo?: string | null;
  providerPayload?: unknown;
  rejectReason?: string | null;
};

const memory = vi.hoisted(() => ({
  orders: new Map<string, OrderRow>(),
  ledger: [] as Array<{ idempotencyKey: string; amountCents: bigint; userId?: string }>,
  audits: [] as Array<{ action: string; target: string | null }>,
  pushed: [] as string[],
  availableCents: 100_000n,
  userStatus: 'ACTIVE' as 'ACTIVE' | 'BANNED',
}));

const depositOrder = vi.hoisted(() => ({
  findUnique: vi.fn(async ({ where }: any) => memory.orders.get(where.id) ?? null),
  findMany: vi.fn(async () => []),
  update: vi.fn(async ({ where, data }: any) => {
    const current = memory.orders.get(where.id);
    if (!current) throw new Error('NOT_FOUND');
    const next = { ...current, ...data };
    memory.orders.set(where.id, next);
    return next;
  }),
  updateMany: vi.fn(async ({ where, data }: any) => {
    const current = memory.orders.get(where.id);
    if (!current || (where.status && current.status !== where.status)) return { count: 0 };
    memory.orders.set(where.id, { ...current, ...data });
    return { count: 1 };
  }),
}));

const auditLog = vi.hoisted(() => ({
  create: vi.fn(async ({ data }: any) => {
    memory.audits.push({ action: data.action, target: data.target ?? null });
    return data;
  }),
}));

const user = vi.hoisted(() => ({
  updateMany: vi.fn(async ({ where, data }: any) => {
    if (where.id !== 'user-1') return { count: 0 };
    memory.userStatus = data.status;
    return { count: 1 };
  }),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { depositOrder, auditLog, user },
}));

vi.mock('../lib/transaction.js', () => ({
  serializable: async (work: (tx: unknown) => unknown) => {
    const ordersBefore = new Map(
      [...memory.orders.entries()].map(([id, order]) => [id, { ...order }]),
    );
    const auditsLength = memory.audits.length;
    const ledgerLength = memory.ledger.length;
    const availableBefore = memory.availableCents;
    const userStatusBefore = memory.userStatus;
    try {
      return await work({ depositOrder, auditLog, user });
    } catch (error) {
      memory.orders.clear();
      for (const [id, order] of ordersBefore) memory.orders.set(id, order);
      memory.audits.length = auditsLength;
      memory.ledger.length = ledgerLength;
      memory.availableCents = availableBefore;
      memory.userStatus = userStatusBefore;
      throw error;
    }
  },
}));

vi.mock('./wallet.js', () => ({
  transfer: vi.fn(async (_tx: unknown, params: any) => {
    // 复刻账本层的唯一约束：同一幂等键只允许记一次
    if (memory.ledger.some((entry) => entry.idempotencyKey === params.idempotencyKey)) {
      throw new Error('DUPLICATE_IDEMPOTENCY_KEY');
    }
    if (
      params.refType === 'vpay_chargeback'
      && memory.availableCents < params.amountCents
    ) {
      throw Object.assign(new Error('INSUFFICIENT_BALANCE'), {
        code: 'INSUFFICIENT_BALANCE',
      });
    }
    if (params.refType === 'vpay_chargeback') {
      memory.availableCents -= params.amountCents;
    }
    memory.ledger.push({
      idempotencyKey: params.idempotencyKey,
      amountCents: params.amountCents,
      userId: params.to?.userId ?? params.from?.userId,
    });
  }),
}));

vi.mock('./push.js', () => ({
  pushService: {
    notifyDepositCompleted: vi.fn(async () => {
      memory.pushed.push('deposit_completed');
      return true;
    }),
    notifyOrderRejected: vi.fn(async () => {
      memory.pushed.push('order_rejected');
      return true;
    }),
  },
}));

vi.mock('./paymentProviders.js', () => ({
  getVpayConfig: vi.fn(async () => ({
    enabled: false,
    baseUrl: '',
    traderId: '',
    apiToken: '',
  })),
}));

import {
  applyVpayOrderState,
  resolveDepositCreditCents,
  sanitizeVpayPayload,
} from './vpayDeposits.js';

const ORDER_ID = 'ckvpayorder0001';

function seedOrder(overrides: Partial<OrderRow> = {}) {
  memory.orders.set(ORDER_ID, {
    id: ORDER_ID,
    userId: 'user-1',
    amountCents: 10_000n,
    status: 'PENDING',
    channel: 'VPAY',
    ...overrides,
  });
}

describe('VPay 充值回调落账', () => {
  beforeEach(() => {
    memory.orders.clear();
    memory.ledger.length = 0;
    memory.audits.length = 0;
    memory.pushed.length = 0;
    memory.availableCents = 100_000n;
    memory.userStatus = 'ACTIVE';
    vi.clearAllMocks();
  });

  it('已支付且金额一致时入账一次', async () => {
    seedOrder();
    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: '3',
      paidAmount: '100.00',
      providerTradeNo: 'TN-1',
      payload: { state: '3' },
      source: 'notify',
    });

    expect(result.outcome).toBe('CREDITED');
    expect(memory.orders.get(ORDER_ID)?.status).toBe('COMPLETED');
    expect(memory.orders.get(ORDER_ID)?.creditedAmountCents).toBe(10_000n);
    expect(memory.ledger).toHaveLength(1);
    expect(memory.ledger[0].idempotencyKey).toBe(`deposit:${ORDER_ID}`);
    expect(memory.ledger[0].amountCents).toBe(10_000n);
    expect(memory.pushed).toContain('deposit_completed');
  });

  it('平台重复通知不会重复加钱', async () => {
    seedOrder();
    const notify = {
      orderId: ORDER_ID,
      state: '3',
      paidAmount: '100.00',
      payload: { state: '3' },
      source: 'notify' as const,
    };
    await applyVpayOrderState(notify);
    const second = await applyVpayOrderState(notify);

    expect(second.outcome).toBe('ALREADY_SETTLED');
    expect(memory.ledger).toHaveLength(1);
  });

  it('人工确认后再收到回调仍只入账一次', async () => {
    seedOrder({ status: 'COMPLETED' });
    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: '3',
      paidAmount: '100.00',
      payload: {},
      source: 'notify',
    });

    expect(result.outcome).toBe('ALREADY_SETTLED');
    expect(memory.ledger).toHaveLength(0);
  });

  it('已入账订单收到冲正时扣回余额并标记为驳回', async () => {
    seedOrder({ status: 'COMPLETED' });

    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: 4,
      paidAmount: '100.00',
      payload: { state: 4 },
      source: 'notify',
    });

    expect(result.outcome).toBe('CHARGEBACK_REVERSED');
    expect(memory.orders.get(ORDER_ID)?.status).toBe('REJECTED');
    expect(memory.availableCents).toBe(90_000n);
    expect(memory.ledger).toContainEqual({
      idempotencyKey: `vpay-chargeback:${ORDER_ID}`,
      amountCents: 10_000n,
      userId: 'user-1',
    });
    expect(memory.audits.map((row) => row.action)).toContain('vpay_deposit_chargeback');
  });

  it('金额不符单经人工按实付入账后，冲正只扣回实际入账额', async () => {
    seedOrder({
      status: 'COMPLETED',
      amountCents: 10_000n,
      paidAmountCents: 5_000n,
      creditedAmountCents: 5_000n,
    });

    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: 4,
      paidAmount: '50.00',
      payload: { state: 4 },
      source: 'notify',
    });

    expect(result.outcome).toBe('CHARGEBACK_REVERSED');
    expect(memory.availableCents).toBe(95_000n);
    expect(memory.ledger[0]?.amountCents).toBe(5_000n);
  });

  it('完成后的实付回调变化不会篡改后续冲正金额', async () => {
    seedOrder({
      status: 'COMPLETED',
      amountCents: 10_000n,
      paidAmountCents: 5_000n,
      creditedAmountCents: 5_000n,
    });

    await applyVpayOrderState({
      orderId: ORDER_ID,
      state: 3,
      paidAmount: '100.00',
      payload: { state: 3 },
      source: 'reconcile',
    });
    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: 4,
      paidAmount: '100.00',
      payload: { state: 4 },
      source: 'reconcile',
    });

    expect(result.outcome).toBe('CHARGEBACK_REVERSED');
    expect(memory.orders.get(ORDER_ID)?.paidAmountCents).toBe(10_000n);
    expect(memory.ledger[0]?.amountCents).toBe(5_000n);
  });

  it('冲正余额不足时封禁账号并留下人工追偿审计', async () => {
    seedOrder({ status: 'COMPLETED' });
    memory.availableCents = 1_000n;

    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: 4,
      paidAmount: '100.00',
      payload: { state: 4 },
      source: 'reconcile',
    });

    expect(result.outcome).toBe('CHARGEBACK_REVIEW_REQUIRED');
    expect(memory.orders.get(ORDER_ID)?.status).toBe('REJECTED');
    expect(memory.userStatus).toBe('BANNED');
    expect(memory.ledger).toHaveLength(0);
    expect(memory.audits.map((row) => row.action)).toContain(
      'vpay_deposit_chargeback_unrecovered',
    );
  });

  it('实付金额不符时不自动入账，留待人工处理', async () => {
    seedOrder();
    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: '3',
      paidAmount: '50.00',
      payload: {},
      source: 'notify',
    });

    expect(result.outcome).toBe('AMOUNT_MISMATCH');
    expect(memory.orders.get(ORDER_ID)?.status).toBe('PENDING');
    expect(memory.orders.get(ORDER_ID)?.paidAmountCents).toBe(5_000n);
    expect(memory.ledger).toHaveLength(0);
    expect(memory.audits.map((row) => row.action)).toContain('vpay_deposit_amount_mismatch');
  });

  it('支付失败置为驳回并通知玩家', async () => {
    seedOrder();
    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: 1,
      paidAmount: '0.00',
      payload: {},
      source: 'notify',
    });

    expect(result.outcome).toBe('REJECTED');
    expect(memory.orders.get(ORDER_ID)?.status).toBe('REJECTED');
    expect(memory.orders.get(ORDER_ID)?.rejectReason).toContain('支付失败');
    expect(memory.ledger).toHaveLength(0);
    expect(memory.pushed).toContain('order_rejected');
  });

  it('待支付状态只留档不改变工单', async () => {
    seedOrder();
    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: 2,
      payload: { state: 2 },
      source: 'reconcile',
    });

    expect(result.outcome).toBe('PENDING');
    expect(memory.orders.get(ORDER_ID)?.status).toBe('PENDING');
    expect(memory.orders.get(ORDER_ID)?.providerPayload).toEqual({ state: 2 });
    expect(memory.ledger).toHaveLength(0);
  });

  it('人工转账工单不受网关回调影响', async () => {
    seedOrder({ channel: 'MANUAL' });
    const result = await applyVpayOrderState({
      orderId: ORDER_ID,
      state: '3',
      paidAmount: '100.00',
      payload: {},
      source: 'notify',
    });

    expect(result.outcome).toBe('NOT_VPAY');
    expect(memory.orders.get(ORDER_ID)?.status).toBe('PENDING');
    expect(memory.ledger).toHaveLength(0);
  });

  it('未知订单号抛错，交由回调层返回非 SUCCESS 触发重试', async () => {
    await expect(
      applyVpayOrderState({
        orderId: 'not-exists',
        state: '3',
        payload: {},
        source: 'notify',
      }),
    ).rejects.toThrow('ORDER_NOT_FOUND');
  });
});

describe('人工确认充值金额', () => {
  it('VPay 有实付金额时按实付入账，不按原下单金额超发', () => {
    expect(
      resolveDepositCreditCents({
        channel: 'VPAY',
        amountCents: 10_000n,
        paidAmountCents: 5_000n,
      }),
    ).toBe(5_000n);
  });

  it('人工转账或尚无实付记录时仍按申请金额入账', () => {
    expect(
      resolveDepositCreditCents({
        channel: 'MANUAL',
        amountCents: 10_000n,
        paidAmountCents: null,
      }),
    ).toBe(10_000n);
    expect(
      resolveDepositCreditCents({
        channel: 'VPAY',
        amountCents: 10_000n,
        paidAmountCents: null,
      }),
    ).toBe(10_000n);
  });
});

describe('VPay 原文留档脱敏', () => {
  it('保留对账状态与单号，但移除签名、密钥和账户资料', () => {
    expect(
      sanitizeVpayPayload({
        state: 3,
        out_trade_no: 'ORDER-1',
        sign: 'secret-signature',
        api_token: 'secret-token',
        account_name: 'Alice',
        acc_name: 'Alice from gateway',
        acc_no: '123456789',
        nested: { phone: '0123456789', amount: '10.00' },
      }),
    ).toEqual({
      state: 3,
      out_trade_no: 'ORDER-1',
      sign: '[REDACTED]',
      api_token: '[REDACTED]',
      account_name: '[REDACTED]',
      acc_name: '[REDACTED]',
      acc_no: '[REDACTED]',
      nested: { phone: '[REDACTED]', amount: '10.00' },
    });
  });
});

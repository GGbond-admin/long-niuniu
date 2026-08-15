import { beforeEach, describe, expect, it, vi } from 'vitest';

type OrderRow = {
  id: string;
  userId: string;
  amountCents: bigint;
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  channel: 'MANUAL' | 'VPAY';
  paidAmountCents?: bigint | null;
  providerTradeNo?: string | null;
  providerPayload?: unknown;
  rejectReason?: string | null;
};

const memory = vi.hoisted(() => ({
  orders: new Map<string, OrderRow>(),
  ledger: [] as Array<{ idempotencyKey: string; amountCents: bigint; userId?: string }>,
  audits: [] as Array<{ action: string; target: string | null }>,
  pushed: [] as string[],
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

vi.mock('../lib/prisma.js', () => ({
  prisma: { depositOrder, auditLog },
}));

vi.mock('../lib/transaction.js', () => ({
  serializable: async (work: (tx: unknown) => unknown) => work({ depositOrder, auditLog }),
}));

vi.mock('./wallet.js', () => ({
  transfer: vi.fn(async (_tx: unknown, params: any) => {
    // 复刻账本层的唯一约束：同一幂等键只允许记一次
    if (memory.ledger.some((entry) => entry.idempotencyKey === params.idempotencyKey)) {
      throw new Error('DUPLICATE_IDEMPOTENCY_KEY');
    }
    memory.ledger.push({
      idempotencyKey: params.idempotencyKey,
      amountCents: params.amountCents,
      userId: params.to?.userId,
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

import { applyVpayOrderState } from './vpayDeposits.js';

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

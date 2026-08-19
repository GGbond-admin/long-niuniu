let token: string | null = null;

export const DEVICE_SESSION_INVALID_EVENT = 'miniapp:device-session-invalid';
const DEVICE_SESSION_ERRORS = new Set([
  'DEVICE_SESSION_EXPIRED',
  'DEVICE_REBIND_REQUIRED',
  'DEVICE_MISMATCH',
]);

export function setToken(t: string | null) {
  token = t;
}

export function getToken(): string | null {
  return token;
}

export function invalidateDeviceSession(code = 'DEVICE_SESSION_EXPIRED'): void {
  // 设备待重绑时 token 对绑定流程仍有效，保留它让用户直接去绑定页，而不是刷新重登
  if (code !== 'DEVICE_REBIND_REQUIRED') token = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(DEVICE_SESSION_INVALID_EVENT, {
        detail: { code },
      }),
    );
  }
}

type RequestPolicy = {
  timeoutMs?: number;
  retries?: number;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function request<T>(
  path: string,
  options: RequestInit = {},
  policy: RequestPolicy = {},
): Promise<T> {
  const timeoutMs = policy.timeoutMs ?? 15_000;
  const retries = Math.max(0, policy.retries ?? 0);

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(path, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
      });
      const body = (await res.json().catch((cause) => {
        if (res.ok) throw cause;
        return {};
      })) as {
        error?: string;
        message?: string;
        details?: unknown;
      };

      if (!res.ok) {
        if (token && body.error && DEVICE_SESSION_ERRORS.has(body.error)) {
          invalidateDeviceSession(body.error);
        }
        throw Object.assign(
          new Error(body.message ?? body.error ?? `HTTP ${res.status}`),
          {
            code: body.error,
            status: res.status,
            details: body.details,
          },
        );
      }
      return body as T;
    } catch (cause) {
      const status = (cause as { status?: number } | null)?.status;
      const timedOut = controller.signal.aborted;
      const error = timedOut
        ? Object.assign(new Error('请求超时，请检查网络后重试'), {
            code: 'REQUEST_TIMEOUT',
          })
        : cause;
      const retryable = timedOut || status === undefined || status >= 500;
      if (attempt >= retries || !retryable) throw error;
      clearTimeout(timeout);
      await wait(350 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function upload<T>(path: string, file: File): Promise<T> {
  const data = new FormData();
  data.append('file', file);
  const res = await fetch(path, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: data,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (token && DEVICE_SESSION_ERRORS.has(body.error)) {
      invalidateDeviceSession(body.error);
    }
    throw Object.assign(new Error(body.message ?? body.error ?? `HTTP ${res.status}`), {
      code: body.error,
      status: res.status,
    });
  }
  return res.json();
}

const joinRoomRequests = new Map<string, Promise<RoomState>>();

function joinRoom(roomId: string): Promise<RoomState> {
  const key = `${token ?? 'anonymous'}:${roomId}`;
  const existing = joinRoomRequests.get(key);
  if (existing) return existing;

  const pending = request<RoomState>(`/api/game/rooms/${roomId}/join`, {
    method: 'POST',
    body: '{}',
  }, {
    timeoutMs: 8_000,
    retries: 1,
  });
  joinRoomRequests.set(key, pending);
  void pending.then(
    () => {
      if (joinRoomRequests.get(key) === pending) joinRoomRequests.delete(key);
    },
    () => {
      if (joinRoomRequests.get(key) === pending) joinRoomRequests.delete(key);
    },
  );
  return pending;
}

export const api = {
  login: (initData: string, deviceId: string, botUsername?: string) =>
    request<{
      token: string;
      user: { id: string; uid: string; nickname: string; avatarUrl?: string };
      onboarding: { inviterBound: boolean; deviceBound: boolean; kycStatus: string };
      security: { paymentPinSet: boolean; paymentPinLockedUntil: string | null };
      pendingInviterUid: string | null;
    }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ initData, deviceId, botUsername }),
    }),

  /** 自助换绑设备：Telegram 身份 + 支付密码双验证，7 天限一次 */
  deviceRebind: (
    initData: string,
    deviceId: string,
    paymentPin: string,
    botUsername?: string,
  ) =>
    request<{ ok: boolean; alreadyBound?: boolean }>('/api/auth/device-rebind', {
      method: 'POST',
      body: JSON.stringify({ initData, deviceId, paymentPin, botUsername }),
    }),

  me: () =>
    request<{
      user: {
        uid: string;
        nickname: string;
        avatarUrl?: string;
        inviteCode?: string;
        tgId?: string;
        tgUsername?: string | null;
        tgDisplayName?: string | null;
        inviter?: { uid: string; nickname: string };
        createdAt?: string;
      };
      stats?: { joinedDays: number; gamesPlayed: number };
      onboarding: { inviterBound: boolean; deviceBound: boolean; kycStatus: string };
      security: { paymentPinSet: boolean; paymentPinLockedUntil: string | null };
      device: {
        status: 'ACTIVE' | 'UNBOUND';
        maskedId: string;
        boundAt: string;
      } | null;
      kyc: {
        status: string;
        realName?: string;
        duitnowIdMasked?: string;
        bankName?: string;
        bankAccountMasked?: string;
        rejectReason?: string;
      } | null;
      wallet: {
        availableCents: string;
        freezeBankerCents: string;
        freezeBetCents: string;
        freezeWithdrawCents: string;
      } | null;
    }>('/api/me'),

  securitySettings: () =>
    request<{
      kycStatus: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
      paymentPin: {
        set: boolean;
        lockedUntil: string | null;
        setAt: string | null;
        updatedAt: string | null;
      };
      device: {
        status: 'ACTIVE' | 'UNBOUND';
        maskedId: string;
        boundAt: string;
      } | null;
    }>('/api/settings/security'),
  deviceSettings: () =>
    request<{
      device: {
        status: 'ACTIVE' | 'UNBOUND';
        maskedId: string;
        boundAt: string;
      } | null;
      policy: {
        oneAccountOneDevice: boolean;
        selfUnbindAllowed: boolean;
      };
    }>('/api/settings/device'),
  setPaymentPin: (pin: string) =>
    request<{ ok: boolean; paymentPinSet: boolean }>('/api/settings/payment-pin', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),
  changePaymentPin: (currentPin: string, newPin: string) =>
    request<{ ok: boolean; paymentPinSet: boolean }>('/api/settings/payment-pin', {
      method: 'PATCH',
      body: JSON.stringify({ currentPin, newPin }),
    }),

  setAvatar: (avatarUrl: string) =>
    request<{ ok: boolean; user: { uid: string; nickname: string; avatarUrl: string | null } }>(
      '/api/me/avatar',
      {
        method: 'POST',
        body: JSON.stringify({ avatarUrl }),
      },
    ),

  setNickname: (nickname: string) =>
    request<{
      ok: boolean;
      user: {
        uid: string;
        nickname: string;
        avatarUrl: string | null;
        tgId: string;
        tgUsername: string | null;
        tgDisplayName: string | null;
        inviteCode: string;
      };
    }>('/api/me/nickname', {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
    }),

  inviterPreview: (uid: string) =>
    request<{ inviter: { uid: string; nickname: string; avatarUrl?: string } }>(`/api/onboarding/inviter/${uid}`),
  bindInviter: (inviterUid: string) =>
    request<{ ok: boolean; alreadyBound?: boolean }>('/api/onboarding/inviter', {
      method: 'POST',
      body: JSON.stringify({ inviterUid }),
    }),
  bindDevice: (deviceId: string) =>
    request<{ ok: boolean }>('/api/onboarding/device', { method: 'POST', body: JSON.stringify({ deviceId }) }),
  submitKyc: (data: {
    realName: string;
    duitnowId: string;
    agreed: true;
  }) => request<{ ok: boolean }>('/api/onboarding/kyc', { method: 'POST', body: JSON.stringify(data) }),

  wallet: (params?: {
    cursor?: string;
    limit?: number;
    scope?: 'all' | 'available';
    category?:
      | 'all'
      | 'deposit'
      | 'withdraw'
      | 'rebate'
      | 'reward'
      | 'game'
      | 'fee'
      | 'packet'
      | 'refund'
      | 'adjust';
  }) => {
    const query = new URLSearchParams();
    if (params?.cursor) query.set('cursor', params.cursor);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.scope) query.set('scope', params.scope);
    if (params?.category) query.set('category', params.category);
    const qs = query.toString();
    return request<{
      balance: {
        availableCents: string;
        freezeBankerCents: string;
        freezeBetCents: string;
        freezeWithdrawCents: string;
      };
      filter?: { scope: string; category: string };
      entries: Array<{
        id: string;
        accountType?: string;
        refType: string;
        direction: string;
        amountCents: string;
        refId?: string | null;
        roundId?: string | null;
        memo?: string | null;
        createdAt: string;
      }>;
      nextCursor?: string | null;
    }>(`/api/wallet${qs ? `?${qs}` : ''}`);
  },
  walletOrders: (params?: {
    cursor?: string;
    limit?: number;
  }) => {
    const search = new URLSearchParams();
    if (params?.cursor) search.set('cursor', params.cursor);
    if (params?.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request<{
      nextCursor?: string | null;
      deposits: Array<{
        id: string;
        channel: 'MANUAL' | 'VPAY';
        amountCents: string;
        status: string;
        rejectReason?: string;
        proofUrl?: string;
        payUrl?: string | null;
        createdAt: string;
      }>;
      withdrawals: Array<{
        id: string;
        amountCents: string;
        feeCents: string;
        netCents: string;
        channel: string;
        status: string;
        rejectReason?: string;
        createdAt: string;
      }>;
    }>(`/api/wallet/orders${qs ? `?${qs}` : ''}`);
  },
  uploadProof: (file: File) => upload<{ url: string }>('/api/uploads/proof', file),
  depositPayee: () =>
    request<{
      payee: {
        id: string;
        bankName: string;
        accountNo: string;
        accountName: string;
        label?: string | null;
      };
    }>('/api/wallet/deposit-payee'),
  deposit: (amount: string, proofUrl: string, requestId: string, payeeAccountId?: string) =>
    request<{ ok: boolean; orderId: string }>('/api/wallet/deposit', {
      method: 'POST',
      body: JSON.stringify({ amount, proofUrl, requestId, payeeAccountId }),
    }),
  depositChannels: () =>
    request<{
      manual: { available: boolean };
      vpay: {
        available: boolean;
        minCents: string;
        maxCents: string;
        tradeCodes: Array<{ code: string; label: string }>;
      };
    }>('/api/wallet/deposit/channels'),
  depositVpay: (amount: string, tradeCode: string, requestId: string) =>
    request<{
      ok: boolean;
      orderId: string;
      status: string;
      payUrl: string | null;
      expiredAt: string | null;
      duplicate: boolean;
    }>('/api/wallet/deposit/vpay', {
      method: 'POST',
      body: JSON.stringify({ amount, tradeCode, requestId }),
    }),
  depositStatus: (orderId: string) =>
    request<{
      id: string;
      status: string;
      channel: string;
      amountCents: string;
      payUrl: string | null;
      expiredAt: string | null;
      rejectReason?: string | null;
    }>(`/api/wallet/deposit/${orderId}/status`),
  paymentInstitutions: () =>
    request<{
      banks: Array<{ code: string; name: string; type: 'BANK' | 'EWALLET' }>;
      ewallets: Array<{ code: string; name: string; type: 'BANK' | 'EWALLET' }>;
    }>('/api/wallet/payment-institutions'),
  withdrawAccounts: () =>
    request<{
      items: Array<{
        id: string;
        type: 'BANK' | 'EWALLET';
        institution: string;
        accountNoMasked: string;
        accountName: string;
        isDefault: boolean;
        status: 'PENDING' | 'APPROVED' | 'REJECTED';
        source: string;
        rejectReason?: string | null;
      }>;
    }>('/api/wallet/withdraw-accounts'),
  addWithdrawAccount: (data: {
    type: 'BANK' | 'EWALLET';
    institution: string;
    accountNo: string;
    accountName?: string;
  }) =>
    request<{ ok: boolean }>('/api/wallet/withdraw-accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWithdrawAccount: (
    id: string,
    data: {
      type: 'BANK' | 'EWALLET';
      institution: string;
      accountNo: string;
      accountName?: string;
    },
  ) =>
    request<{ ok: boolean }>(`/api/wallet/withdraw-accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteWithdrawAccount: (id: string) =>
    request<{ ok: boolean }>(`/api/wallet/withdraw-accounts/${id}`, {
      method: 'DELETE',
    }),
  setDefaultWithdrawAccount: (id: string) =>
    request<{ ok: boolean }>(`/api/wallet/withdraw-accounts/${id}/default`, {
      method: 'POST',
      body: '{}',
    }),
  withdrawInfo: () =>
    request<{
      minCents: string;
      freeDailyLimit: number;
      freeRemaining: number;
      usedToday: number;
      feeRatioAfterFree: number;
      date: string;
    }>('/api/wallet/withdraw-info'),
  withdraw: (amount: string, accountId: string, requestId: string, paymentPin: string) =>
    request<{
      ok: boolean;
      orderId: string;
      feeCents: string;
      netCents: string;
      freeQuota: boolean;
    }>(
      '/api/wallet/withdraw',
      {
        method: 'POST',
        body: JSON.stringify({ amount, accountId, requestId, paymentPin }),
      },
    ),

  lobby: () =>
    request<{
      announcements: Array<{
        id: string;
        title: string;
        body: string;
        imageUrl?: string;
      }>;
      games: Array<{
        gameCode: string;
        id: string;
        title: string;
        interactionGroupTitle: string;
        inviteLink: string | null;
        kycRequired: boolean;
        online: number;
        round: {
          id: string;
          seqNo: number;
          phase: string;
          bidEndsAt?: string;
          betEndsAt?: string;
          claimEndsAt?: string;
        } | null;
      }>;
    }>('/api/game/lobby'),

  joinRoom,
  leaveRoom: (roomId: string) =>
    request<{ ok: boolean }>(`/api/game/rooms/${roomId}/leave`, { method: 'POST', body: '{}' }),
  roomState: (roomId: string) => request<RoomState>(`/api/game/rooms/${roomId}/state`),
  roomWsTicket: (roomId: string) =>
    request<{ ticket: string; expiresIn: number }>(
      `/api/game/rooms/${roomId}/ws-ticket`,
      { method: 'POST', body: '{}' },
      { timeoutMs: 8_000, retries: 1 },
    ),
  placeBid: (roomId: string, amount: string) =>
    request<RoomState>(`/api/game/rooms/${roomId}/bid`, {
      method: 'POST',
      body: JSON.stringify({ amount }),
    }),
  placeBet: (roomId: string, amount: string, allIn = false) =>
    request<RoomState>(`/api/game/rooms/${roomId}/bet`, {
      method: 'POST',
      body: JSON.stringify({ amount, allIn }),
    }),
  withdrawBet: (roomId: string) =>
    request<RoomState>(`/api/game/rooms/${roomId}/withdraw-bet`, { method: 'POST', body: '{}' }),
  continueBanker: (roomId: string, previousRoundId: string) =>
    request<RoomState>(`/api/game/rooms/${roomId}/continue`, {
      method: 'POST',
      body: JSON.stringify({ previousRoundId }),
    }),
  claimPacket: (packetId: string) =>
    request<{
      /** TNG 红包：外部领取链接 */
      url?: string;
      /** 内部红包：金额已拆分入余额 */
      channel?: 'INTERNAL';
      amountCents?: string;
      handType?: string | null;
      points?: number | null;
    }>(`/api/game/packets/${packetId}/claim`, { method: 'POST', body: '{}' }),
  /** 牌局红包详情：结束后仍可查看抢包/认额名单 */
  gamePacket: (packetId: string) =>
    request<{
      id: string;
      channel: 'TNG' | 'INTERNAL';
      status: string;
      phase: string;
      totalCents: string;
      participantCount: number;
      claims: Array<{
        uid: string;
        nickname: string | null;
        avatarUrl: string | null;
        amountCents: string;
        isBanker: boolean;
        isTail: boolean;
        at: string;
      }>;
    }>(`/api/game/packets/${packetId}`),

  sendGroupPacket: (
    roomId: string,
    amount: string,
    count: number,
    mode: 'RANDOM' | 'EQUAL',
    greeting: string,
    requestId: string,
    paymentPin: string,
  ) =>
    request<{ ok: boolean; packetId: string; duplicate: boolean }>(
      `/api/game/rooms/${roomId}/group-packets`,
      {
        method: 'POST',
        body: JSON.stringify({ amount, count, mode, greeting, requestId, paymentPin }),
      },
    ),
  claimGroupPacket: (packetId: string) =>
    request<{ ok: boolean; amountCents: string }>(`/api/game/group-packets/${packetId}/claim`, {
      method: 'POST',
      body: '{}',
    }),
  groupPacket: (packetId: string) =>
    request<{
      id: string;
      sender: { uid: string; nickname: string | null; avatarUrl: string | null };
      totalCents: string;
      count: number;
      remainingCount: number;
      status: string;
      claims: Array<{
        uid: string;
        nickname: string | null;
        avatarUrl: string | null;
        amountCents: string;
        at: string;
      }>;
    }>(`/api/game/group-packets/${packetId}`),
  groupPacketClaimStatus: (ids: string[]) =>
    request<{
      items: Array<{ id: string; mineCents: string | null; gone: boolean }>;
    }>('/api/game/group-packets/claim-status', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  tipSupport: (
    roomId: string,
    amount: string,
    requestId: string,
    paymentPin: string,
  ) =>
    request<{
      ok: boolean;
      duplicate: boolean;
      nickname: string;
      amountCents: string;
      message: string;
      avatarUrl: string | null;
    }>(`/api/game/rooms/${roomId}/tip`, {
      method: 'POST',
      body: JSON.stringify({ amount, requestId, paymentPin }),
    }),

  gameRules: (gameCode: string) =>
    request<{
      gameCode: string;
      document: {
        title: string;
        summary: string;
        sections: Array<{ id: string; title: string; body: string }>;
        version: number;
        publishedAt: string | null;
      };
      handLabels: Record<string, string>;
      config: {
        hand: {
          multipliers: Record<string, number>;
          normalMultipliers: Record<string, number>;
          bustThreshold: number;
          bustExemptSpecialHands: boolean;
        };
        betting: Record<string, number | Array<Record<string, number>>>;
        fees: Record<string, number>;
        round: Record<string, number>;
      };
      hand: {
        multipliers: Record<string, number>;
        normalMultipliers: Record<string, number>;
        bustThreshold: number;
      };
      betting: {
        betMinCents: number;
        shMinCents: number;
        betRatio: number;
        shRatio: number;
      };
      fees: {
        bankerSeatFeeRatio: number;
        serviceFeeCents: number;
        packetPerHeadCents: number;
        playerRakeRatio: number;
        bankerRakeRatio: number;
        /** @deprecated 旧版单一抽水比例，仅历史配置存在 */
        rakeRatio?: number;
      };
      round: {
        bidDurationSeconds: number;
        betDurationSeconds: number;
        claimDurationSeconds: number;
      };
    }>(`/api/game/rules?gameCode=${encodeURIComponent(gameCode)}`),

  rewards: (gameCode: string, date?: string) =>
    request<{
      gameCode: string;
      date: string;
      counts: Record<string, number>;
      items: Array<{
        id: string;
        tab: 'CHESS' | 'BANKER' | 'SPECIAL';
        code: string;
        title: string;
        conditions: Record<string, unknown>;
        amountCents: string;
        dailyQuota: number;
        remaining: number | null;
        achieved: boolean;
        granted: boolean;
      }>;
      winners?: Array<{
        uid: string;
        nickname: string;
        avatarUrl: string | null;
        title: string;
        amountCents: string;
      }>;
    }>(
      `/api/rewards?gameCode=${encodeURIComponent(gameCode)}` +
        (date ? `&date=${encodeURIComponent(date)}` : ''),
    ),
  leaderboards: (
    gameCode: string,
    period: 'daily' | 'weekly' | 'monthly' = 'daily',
  ) =>
    request<{
      gameCode: string;
      period: string;
      periodKey: string;
      enabledTypes: Array<'points' | 'hands' | 'banker'>;
      labels: Record<'points' | 'hands' | 'banker', string>;
      boards: Record<
        string,
        {
          generatedAt: string;
          ranks: Array<{
            rank: number;
            uid: string;
            nickname: string;
            avatarUrl: string | null;
            score: string;
          }>;
        }
      >;
    }>(
      `/api/leaderboards?gameCode=${encodeURIComponent(gameCode)}&period=${period}`,
    ),

  stickers: () =>
    request<{ items: Array<{ id: string; name: string; url: string }> }>('/api/chat/stickers'),
  chatPreview: () =>
    request<{
      unread: number;
      latest: {
        id: string;
        senderType: 'USER' | 'SUPPORT' | 'SYSTEM';
        type: 'TEXT' | 'EMOJI' | 'STICKER' | 'IMAGE';
        content?: string;
        assetUrl?: string;
        createdAt: string;
      } | null;
    }>('/api/chat/preview'),
  chatMessages: (cursor?: string) =>
    request<{
      items: Array<{
        id: string;
        senderType: 'USER' | 'SUPPORT' | 'SYSTEM';
        type: 'TEXT' | 'EMOJI' | 'STICKER' | 'IMAGE';
        content?: string;
        assetUrl?: string;
        createdAt: string;
      }>;
      nextCursor: string | null;
    }>(
      `/api/chat/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  sendChat: (
    payload:
      | { type: 'TEXT' | 'EMOJI'; content: string }
      | { type: 'STICKER'; stickerId: string },
  ) =>
    request<{ ok: boolean }>('/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  promotion: (date?: string) =>
    request<{
      rates: { self: number; l1: number; l2: number };
      date: string;
      commissionCents: string;
      turnover: { selfCents: string; l1Cents: string; l2Cents: string };
      invitedTotal: number;
      invitedThisMonth: number;
      commissionStatus: 'PAID' | 'ESTIMATED';
      downlines: Array<{
        uid: string;
        nickname: string;
        avatarUrl: string | null;
        boundAt: string;
        contributionCents: string;
      }>;
    }>(`/api/promotion${date ? `?date=${date}` : ''}`),

  inviteLink: () =>
    request<{ uid: string; nickname: string; avatarUrl?: string; deepLink: string }>('/api/promotion/invite-link'),

  /** 代理身份（非代理返回 agent: null，用于「代理专属」入口显隐） */
  agentMe: () =>
    request<{
      agent: {
        id: string;
        label: string;
        sharePoints: number;
        bucketBase: number;
        minReservePoints: number;
        maxChildPoints: number;
        playerCount: number;
        subagentCount: number;
      } | null;
    }>('/api/agent/me'),

  agentReport: (poolId?: string) =>
    request<{
      profile: {
        id: string;
        label: string;
        uidMasked: string;
        nickname: string | null;
        avatarUrl: string | null;
        sharePoints: number;
        directAgentCount: number;
        teamAgentCount: number;
        directPlayerCount: number;
        teamPlayerCount: number;
        online: boolean;
        onlineTeamCount: number;
        lifetimeProfitCents: string;
      };
      periods: Array<{
        poolId: string;
        poolCode: string;
        room: { id: string; title: string; gameCode: string };
        startSeqNo: number;
        endSeqNo: number;
        status: 'PENDING' | 'DISTRIBUTED' | 'NO_DISTRIBUTION';
        generatedAt: string;
        amountCents: string;
      }>;
      periodsNextCursor: string | null;
      selected: {
        pool: {
          id: string;
          poolCode: string;
          room: { id: string; title: string; gameCode: string };
          startSeqNo: number;
          endSeqNo: number;
          status: 'PENDING' | 'DISTRIBUTED' | 'NO_DISTRIBUTION';
          generatedAt: string;
        };
        mine: {
          sharePoints: number;
          bucketBase: number;
          directAgentCount: number;
          teamAgentCount: number;
          directPlayerCount: number;
          teamPlayerCount: number;
          selfTurnoverCents: string;
          teamTurnoverCents: string;
          contributionBp: number;
          selfAmountCents: string;
          overrideAmountCents: string;
          totalAmountCents: string;
          lifetimeProfitCents: string;
        };
        subagents: Array<{
          agentId: string;
          label: string;
          uidMasked: string;
          sharePoints: number;
          diffPoints: number;
          directAgentCount: number;
          teamAgentCount: number;
          directPlayerCount: number;
          teamPlayerCount: number;
          teamTurnoverCents: string;
          ownAmountCents: string;
          contributionAmountCents: string;
        }>;
        players: Array<{
          userId: string;
          uidMasked: string;
          nickname: string | null;
          avatarUrl: string | null;
          turnoverCents: string;
          profitCents: string;
        }>;
        playersNextCursor: string | null;
      } | null;
    }>(`/api/agent/report${poolId ? `?poolId=${encodeURIComponent(poolId)}` : ''}`),

  agentReportHistory: (cursor: string) =>
    request<{
      items: Array<{
        poolId: string;
        poolCode: string;
        room: { id: string; title: string; gameCode: string };
        startSeqNo: number;
        endSeqNo: number;
        status: 'PENDING' | 'DISTRIBUTED' | 'NO_DISTRIBUTION';
        generatedAt: string;
        amountCents: string;
      }>;
      nextCursor: string | null;
    }>(`/api/agent/report/history?cursor=${encodeURIComponent(cursor)}&limit=50`),

  agentReportPlayers: (poolId: string, cursor: string) =>
    request<{
      items: Array<{
        userId: string;
        uidMasked: string;
        nickname: string | null;
        avatarUrl: string | null;
        turnoverCents: string;
        profitCents: string;
      }>;
      nextCursor: string | null;
    }>(
      `/api/agent/report/players?poolId=${encodeURIComponent(poolId)}&cursor=${encodeURIComponent(cursor)}&limit=50`,
    ),

  agentPlayers: () =>
    request<{
      maxChildPoints: number;
      bucketBase: number;
      items: Array<{
        playerId: string;
        uidMasked: string;
        nickname: string | null;
        avatarUrl: string | null;
        joinedAt: string;
        boundAt: string;
        source: 'MANUAL' | 'REFERRAL';
        totalTurnoverCents: string;
      }>;
    }>('/api/agent/players'),

  agentPromote: (playerId: string, sharePoints: number, label?: string) =>
    request<{ ok: boolean }>(`/api/agent/players/${playerId}/promote`, {
      method: 'POST',
      body: JSON.stringify({ sharePoints, label }),
    }),

  agentSubagents: () =>
    request<{
      mine: {
        sharePoints: number;
        bucketBase: number;
        minReservePoints: number;
        maxChildPoints: number;
      };
      items: Array<{
        agentId: string;
        label: string;
        uidMasked: string;
        nickname: string | null;
        avatarUrl: string | null;
        sharePoints: number;
        status: 'ACTIVE' | 'DISABLED';
        playerCount: number;
        subagentCount: number;
        myDiffPoints: number;
        createdAt: string;
      }>;
    }>('/api/agent/subagents'),

  agentSetSubagentPoints: (agentId: string, sharePoints: number) =>
    request<{ ok: boolean }>(`/api/agent/subagents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ sharePoints }),
    }),

  notices: () =>
    request<{
      items: Array<{
        id: string;
        title: string;
        body: string;
        publishedAt: string;
        read: boolean;
        readAt: string | null;
      }>;
      unread: number;
    }>('/api/notices'),
  noticesPreview: () =>
    request<{
      unread: number;
      latest: {
        id: string;
        title: string;
        body: string;
        publishedAt: string;
        read: boolean;
      } | null;
    }>('/api/notices/preview'),
  readNotice: (id: string) =>
    request<{ ok: boolean }>(`/api/notices/${id}/read`, { method: 'POST', body: '{}' }),
  readAllNotices: () =>
    request<{ ok: boolean }>('/api/notices/read-all', { method: 'POST', body: '{}' }),
};

export type RoomState = {
  room: {
    id: string;
    gameCode: string;
    title: string;
    interactionGroupTitle: string;
    status: string;
    minPlayers: number;
    members: number;
    online: number;
  };
  me: {
    joined: boolean;
    isBanker: boolean;
    bidCents: string | null;
    bet: { amountCents: string; reservedCents?: string; isAllIn: boolean } | null;
    canClaim: boolean;
    /** 本局我已认领/抢到的红包金额（内部红包抢包后即有值） */
    claimedAmountCents?: string | null;
    playedRounds24h?: number;
  };
  round: {
    id: string;
    seqNo: number;
    phase: string;
    potCents: string;
    bidEndsAt?: string | null;
    betEndsAt?: string | null;
    claimEndsAt?: string | null;
    banker: { uid: string; nickname: string; avatarUrl: string | null } | null;
    topBids: Array<{
      uid: string;
      nickname: string;
      avatarUrl: string | null;
      amountCents: string;
    }>;
    bidCount: number;
    bets: Array<{
      uid: string;
      nickname: string;
      avatarUrl: string | null;
      amountCents: string;
      isAllIn: boolean;
    }>;
    claimedCount: number;
    diceThrown?: boolean;
    participantCount: number | null;
    packetId: string | null;
    /** TNG=跳转外部链接抢包；INTERNAL=小助手直发、群内直接抢 */
    packetChannel?: 'TNG' | 'INTERNAL';
    packetTotalCents?: string | null;
    claims?: Array<{
      uid: string;
      nickname: string;
      avatarUrl: string | null;
      amountCents: string;
      source: string;
      isBanker: boolean;
      isTail: boolean;
      at: string;
    }>;
    betRange: {
      betMinCents: number;
      betMaxCents: number;
      shMinCents: number;
      shMaxCents: number;
    } | null;
  } | null;
  lastScoreboard: {
    seqNo: number;
    playerLines: unknown;
    bankerSummary: unknown;
  } | null;
  continuation: { previousRoundId: string; mine: boolean; deadline: string } | null;
  pins?: Array<{ id: string; title: string; body: string }>;
  config: {
    bidDurationSeconds: number;
    betDurationSeconds: number;
    claimDurationSeconds: number;
    bankerBidMinCents: number;
    bankerBidMaxCents: number;
    autoTailPacketEnabled?: boolean;
  };
  /** 仅 POST /bet 响应携带；房间状态轮询可不含此字段。 */
  betAcceptance?: {
    requestedAmountCents: string;
    amountCents: string;
    reservedCents: string;
    liabilityBalanceCents: string;
    maxAffordableCents: string;
    roomMaxCents: string;
    maxAcceptedCents: string;
    maxMultiplier: number;
    /** 本笔预留倍数：普通下注=本局最高牌型倍数，梭哈=1 */
    liabilityMultiplier?: number;
    adjusted: boolean;
    adjustedBy: string[];
  };
};

export function roomWsUrl(roomId: string, ticket: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/game/rooms/${roomId}/ws?ticket=${encodeURIComponent(ticket)}`;
}

export function rm(cents: string | number | bigint): string {
  const n = BigInt(cents);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

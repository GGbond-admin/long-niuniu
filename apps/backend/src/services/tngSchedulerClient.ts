import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export const TNG_SCHEDULER_PATHS = {
  ping: '/api/v1/system/ping',
  create: '/api/v1/packets/create',
  query: '/api/v1/packets/query',
} as const;

export const PACKET_ID_RE = /^pkt_[a-f0-9]{32}$/;

export type TngSchedulerCredentials = {
  baseUrl: string;
  keyId: string;
  secret: string;
};

export type SignedRequest = {
  rawBody: string;
  headers: Record<string, string>;
};

export type SchedulerErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type SchedulerOk<T> = {
  ok: true;
  status: number;
  requestId: string;
  serverTime: string;
  data: T;
};

export type SchedulerErr = {
  ok: false;
  status: number;
  requestId?: string;
  serverTime?: string;
  error: SchedulerErrorBody;
};

export type SchedulerResult<T> = SchedulerOk<T> | SchedulerErr;

export type PacketStatus =
  | 'QUEUED'
  | 'CREATING'
  | 'READY'
  | 'CLAIMING'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'FAILED'
  | 'CANCELLED';

export type CreateReq = {
  packetId: string;
  totalAmountCents: number;
  packetCount: number;
};

export type CreateResp = {
  packetId: string;
  status: PacketStatus;
  duplicate: boolean;
  acceptedAt: string;
  pollAfterMs: number;
};

export type QueryReq = {
  packetId: string;
  afterSequence?: number;
  limit?: number;
};

export type SchedulerClaim = {
  claimId: string;
  sequence: number;
  tngName: string;
  amountCents: number;
  claimedAt: string;
};

export type QueryResp = {
  packetId: string;
  status: PacketStatus;
  totalAmountCents: number;
  packetCount: number;
  shareUrl: string | null;
  deepLink: string | null;
  claimedCount: number;
  claimedAmountCents: number;
  remainingCount: number;
  remainingAmountCents: number;
  claimsFinal: boolean;
  claims: SchedulerClaim[];
  nextSequence: number;
  hasMore: boolean;
  acceptedAt: string;
  linkReadyAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  failure: { code: string; message: string; retryable: boolean } | null;
  pollAfterMs: number;
};

export type PingResp = {
  echo: string | null;
  service: string;
  apiVersion: string;
};

const RETRYABLE_CODES = new Set([
  'AUTH_TIMESTAMP_INVALID',
  'AUTH_NONCE_REPLAY',
  'RATE_LIMITED',
  'NO_CAPACITY',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export function generateSchedulerPacketId(): string {
  return `pkt_${randomBytes(16).toString('hex')}`;
}

export function signCanonicalRequest(params: {
  path: string;
  rawBody: string;
  secret: string;
  timestamp: string;
  nonce: string;
}): { contentHash: string; signature: string; canonicalRequest: string } {
  const contentHash = createHash('sha256').update(params.rawBody, 'utf8').digest('hex');
  const canonicalRequest = [
    'TNG-HMAC-SHA256',
    params.timestamp,
    params.nonce,
    'POST',
    params.path,
    contentHash,
  ].join('\n');
  const signature = createHmac('sha256', params.secret)
    .update(canonicalRequest, 'utf8')
    .digest('hex');
  return { contentHash, signature, canonicalRequest };
}

export function signRequest(
  path: string,
  payload: unknown,
  credentials: Pick<TngSchedulerCredentials, 'keyId' | 'secret'>,
  options?: { timestamp?: string; nonce?: string; rawBody?: string },
): SignedRequest {
  const rawBody = options?.rawBody ?? JSON.stringify(payload);
  const timestamp = options?.timestamp ?? Date.now().toString();
  const nonce = options?.nonce ?? randomUUID();
  const { contentHash, signature } = signCanonicalRequest({
    path,
    rawBody,
    secret: credentials.secret,
    timestamp,
    nonce,
  });
  return {
    rawBody,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-TNG-Key-Id': credentials.keyId,
      'X-TNG-Timestamp': timestamp,
      'X-TNG-Nonce': nonce,
      'X-TNG-Content-SHA256': contentHash,
      'X-TNG-Signature': signature,
    },
  };
}

function parseErrorPayload(status: number, raw: string): SchedulerErr {
  try {
    const parsed = JSON.parse(raw) as {
      requestId?: string;
      serverTime?: string;
      error?: SchedulerErrorBody;
    };
    if (parsed.error?.code) {
      return {
        ok: false,
        status,
        requestId: parsed.requestId,
        serverTime: parsed.serverTime,
        error: {
          code: parsed.error.code,
          message: parsed.error.message ?? parsed.error.code,
          retryable: parsed.error.retryable ?? RETRYABLE_CODES.has(parsed.error.code),
          details: parsed.error.details,
        },
      };
    }
  } catch {
    // 非 JSON 错误体按 HTTP 状态归类
  }
  return {
    ok: false,
    status,
    error: {
      code: status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
      message: raw.slice(0, 200) || `HTTP ${status}`,
      retryable: status >= 500 || status === 429,
    },
  };
}

export async function schedulerPost<T>(
  credentials: TngSchedulerCredentials,
  path: string,
  payload: unknown,
  timeoutMs: number,
): Promise<SchedulerResult<T>> {
  const signed = signRequest(path, payload, credentials);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${credentials.baseUrl}${path}`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.rawBody,
      signal: controller.signal,
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      return parseErrorPayload(response.status, text);
    }
    const parsed = JSON.parse(text) as {
      ok?: boolean;
      requestId?: string;
      serverTime?: string;
      data?: T;
      error?: SchedulerErrorBody;
    };
    if (parsed.ok === false && parsed.error) {
      return parseErrorPayload(response.status, text);
    }
    return {
      ok: true,
      status: response.status,
      requestId: parsed.requestId ?? '',
      serverTime: parsed.serverTime ?? '',
      data: parsed.data as T,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      error: {
        code: aborted ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
        message: aborted ? '请求超时' : error instanceof Error ? error.message : '网络错误',
        retryable: true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export function pingScheduler(credentials: TngSchedulerCredentials, echo?: string) {
  return schedulerPost<PingResp>(
    credentials,
    TNG_SCHEDULER_PATHS.ping,
    echo ? { echo: echo.slice(0, 256) } : {},
    5_000,
  );
}

export function createSchedulerPacket(credentials: TngSchedulerCredentials, body: CreateReq) {
  return schedulerPost<CreateResp>(credentials, TNG_SCHEDULER_PATHS.create, body, 10_000);
}

export function querySchedulerPacket(credentials: TngSchedulerCredentials, body: QueryReq) {
  return schedulerPost<QueryResp>(credentials, TNG_SCHEDULER_PATHS.query, body, 10_000);
}

export function isTerminalStatus(status: PacketStatus): boolean {
  return status === 'COMPLETED' || status === 'EXPIRED' || status === 'FAILED' || status === 'CANCELLED';
}

export function hasPublishableLink(data: Pick<QueryResp, 'shareUrl' | 'deepLink'>): boolean {
  return Boolean(data.shareUrl || data.deepLink);
}

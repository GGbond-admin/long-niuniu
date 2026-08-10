import { DEFAULT_TNG_PACKET_HOSTS } from './lib/tngPacketUrl.js';

const nodeEnv = process.env.NODE_ENV ?? 'development';

function resolveTngPacketHosts(): string[] {
  const fromEnv = (process.env.TNG_PACKET_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  // 生产默认放行官方 Money Packet 分享域；开发留空表示不限制域名（便于单测）
  if (nodeEnv === 'production') return [...DEFAULT_TNG_PACKET_HOSTS];
  return [];
}

export const env = {
  port: parseInt(process.env.PORT ?? '8080', 10),
  nodeEnv,
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6380',
  adminJwtSecret: process.env.ADMIN_JWT_SECRET ?? 'dev-secret',
  sensitiveDataKey: process.env.SENSITIVE_DATA_KEY ?? process.env.ADMIN_JWT_SECRET ?? 'dev-sensitive-key',
  defaultBotToken: process.env.DEFAULT_BOT_TOKEN ?? '',
  defaultBotUsername: process.env.DEFAULT_BOT_USERNAME ?? '',
  miniappUrl: process.env.MINIAPP_URL ?? 'https://example.com',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  seedAdminUsername: process.env.SEED_ADMIN_USERNAME ?? 'admin',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? (nodeEnv === 'development' ? 'admin123' : ''),
  trustProxy: process.env.TRUST_PROXY === 'true',
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
  publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? '8080'}`,
  tngPacketHosts: resolveTngPacketHosts(),
  /** 开启后可由系统自动登记发包链接（模板含 {{packetId}}） */
  tngAutoPacketUrlTemplate: process.env.TNG_AUTO_PACKET_URL_TEMPLATE ?? '',
};

if (nodeEnv === 'production') {
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL must be set in production');
  }
  if (env.adminJwtSecret.length < 32) {
    throw new Error('ADMIN_JWT_SECRET must contain at least 32 characters in production');
  }
  if (!process.env.SENSITIVE_DATA_KEY || process.env.SENSITIVE_DATA_KEY.length < 32) {
    throw new Error('SENSITIVE_DATA_KEY must contain at least 32 characters in production');
  }
  if (env.sensitiveDataKey === env.adminJwtSecret) {
    throw new Error('SENSITIVE_DATA_KEY must be independent from ADMIN_JWT_SECRET');
  }
  if (
    !env.miniappUrl.startsWith('https://') ||
    !env.publicApiUrl.startsWith('https://')
  ) {
    throw new Error('MINIAPP_URL and PUBLIC_API_URL must use HTTPS in production');
  }
  if (env.corsOrigins.length === 0 || env.corsOrigins.some((origin) => origin === '*')) {
    throw new Error('CORS_ORIGINS must contain explicit trusted origins in production');
  }
}

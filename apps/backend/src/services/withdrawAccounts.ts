import { prisma } from '../lib/prisma.js';
import { decryptSecret, encryptSecret, safeDecryptSecret, safeMaskSecret } from '../lib/crypto.js';

export async function ensureKycWithdrawAccounts(userId: string) {
  const kyc = await prisma.kyc.findUnique({ where: { userId } });
  if (!kyc || kyc.status !== 'APPROVED') return;

  const existing = await prisma.withdrawAccount.count({ where: { userId } });
  if (existing > 0) return;

  const realName = decryptSecret(kyc.realName);
  const duitnowId = decryptSecret(kyc.duitnowId);
  const bankAccount = decryptSecret(kyc.bankAccount).trim();
  const accountHolder = decryptSecret(kyc.accountHolder);
  const reviewedAt = kyc.reviewedAt ?? new Date();

  // 实名通过后默认同步 TNG；银行卡由用户在「提现账户」中另行添加。
  // 兼容历史 KYC 已填银行的资料：仍一并种子银行账户。
  const creates = [
    prisma.withdrawAccount.create({
      data: {
        userId,
        type: 'EWALLET',
        institution: "Touch 'n Go eWallet",
        accountNo: encryptSecret(duitnowId),
        accountName: encryptSecret(realName),
        isDefault: true,
        status: 'APPROVED',
        source: 'kyc',
        reviewedAt,
        reviewedBy: kyc.reviewedBy,
      },
    }),
  ];
  if (kyc.bankName.trim() && bankAccount) {
    creates.push(
      prisma.withdrawAccount.create({
        data: {
          userId,
          type: 'BANK',
          institution: kyc.bankName,
          accountNo: encryptSecret(bankAccount),
          accountName: encryptSecret(accountHolder || realName),
          isDefault: false,
          status: 'APPROVED',
          source: 'kyc',
          reviewedAt,
          reviewedBy: kyc.reviewedBy,
        },
      }),
    );
  }
  await prisma.$transaction(creates);
}

export function serializeWithdrawAccount(row: {
  id: string;
  type: string;
  institution: string;
  accountNo: string;
  accountName: string;
  isDefault: boolean;
  status: string;
  source: string;
  rejectReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  reviewedAt?: Date | null;
}) {
  return {
    id: row.id,
    type: row.type,
    institution: row.institution,
    accountNoMasked: safeMaskSecret(row.accountNo),
    accountName: safeDecryptSecret(row.accountName),
    isDefault: row.isDefault,
    status: row.status,
    source: row.source,
    rejectReason: row.rejectReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reviewedAt: row.reviewedAt ?? null,
  };
}

export function serializeWithdrawAccountAdmin(row: {
  id: string;
  userId: string;
  type: string;
  institution: string;
  accountNo: string;
  accountName: string;
  isDefault: boolean;
  status: string;
  source: string;
  rejectReason: string | null;
  createdAt: Date;
  reviewedAt?: Date | null;
  user?: { uid: string; nickname: string | null };
}) {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    institution: row.institution,
    accountNo: decryptSecret(row.accountNo),
    accountName: decryptSecret(row.accountName),
    isDefault: row.isDefault,
    status: row.status,
    source: row.source,
    rejectReason: row.rejectReason,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt ?? null,
    user: row.user
      ? { uid: row.user.uid, nickname: row.user.nickname }
      : undefined,
  };
}

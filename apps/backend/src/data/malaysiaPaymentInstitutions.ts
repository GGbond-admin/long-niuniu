/**
 * 马来西亚银行 / 电子钱包目录
 * 银行名单主要参考 Touch 'n Go DuitNow Transfer Bank Listing；
 * 电子钱包参考马来西亚主流 DuitNow / e-money 参与方（2026）。
 */

export type PaymentInstitution = {
  code: string;
  name: string;
  type: 'BANK' | 'EWALLET';
};

export const MALAYSIA_BANKS: PaymentInstitution[] = [
  { code: 'affin', name: 'Affin Bank Berhad', type: 'BANK' },
  { code: 'agrobank', name: 'Agrobank', type: 'BANK' },
  { code: 'alliance', name: 'Alliance Bank Malaysia Berhad', type: 'BANK' },
  { code: 'alrajhi', name: 'Al-Rajhi Bank', type: 'BANK' },
  { code: 'ambank', name: 'AmBank Malaysia Berhad', type: 'BANK' },
  { code: 'bankislam', name: 'Bank Islam Malaysia Berhad', type: 'BANK' },
  { code: 'bankrakyat', name: 'Bank Kerjasama Rakyat Malaysia Berhad', type: 'BANK' },
  { code: 'muamalat', name: 'Bank Muamalat Malaysia Berhad', type: 'BANK' },
  { code: 'bofa', name: 'Bank of America (M) Berhad', type: 'BANK' },
  { code: 'boc', name: 'Bank of China (M) Berhad', type: 'BANK' },
  { code: 'bsn', name: 'Bank Simpanan Nasional Berhad', type: 'BANK' },
  { code: 'bnp', name: 'BNP Paribas Malaysia Berhad', type: 'BANK' },
  { code: 'ccb', name: 'China Construction Bank (Malaysia)', type: 'BANK' },
  { code: 'cimb', name: 'CIMB Bank Berhad', type: 'BANK' },
  { code: 'citi', name: 'Citibank Berhad', type: 'BANK' },
  { code: 'deutsche', name: 'Deutsche Bank (Malaysia) Berhad', type: 'BANK' },
  { code: 'hlb', name: 'Hong Leong Bank Berhad', type: 'BANK' },
  { code: 'hsbc', name: 'HSBC Bank Malaysia Berhad', type: 'BANK' },
  { code: 'icbc', name: 'Industrial and Commercial Bank of China (M) Berhad', type: 'BANK' },
  { code: 'jpmorgan', name: 'JP Morgan Chase Bank Berhad', type: 'BANK' },
  { code: 'kfh', name: 'Kuwait Finance House', type: 'BANK' },
  { code: 'maybank', name: 'Maybank Berhad', type: 'BANK' },
  { code: 'mbsb', name: 'MBSB Bank Berhad', type: 'BANK' },
  { code: 'mizuho', name: 'Mizuho Bank (Malaysia) Berhad', type: 'BANK' },
  { code: 'mufg', name: 'MUFG Bank (Malaysia) Berhad', type: 'BANK' },
  { code: 'ocbc', name: 'OCBC Bank Berhad', type: 'BANK' },
  { code: 'public', name: 'Public Bank Berhad', type: 'BANK' },
  { code: 'rhb', name: 'RHB Bank Berhad', type: 'BANK' },
  { code: 'sc', name: 'Standard Chartered Bank Malaysia Berhad', type: 'BANK' },
  { code: 'smbc', name: 'Sumitomo Mitsui Banking Corporation (M) Berhad', type: 'BANK' },
  { code: 'uob', name: 'United Overseas Bank Berhad (UOB)', type: 'BANK' },
  // Digital banks
  { code: 'gxbank', name: 'GX Bank', type: 'BANK' },
  { code: 'aeonbank', name: 'AEON Bank', type: 'BANK' },
  { code: 'boostbank', name: 'Boost Bank', type: 'BANK' },
];

export const MALAYSIA_EWALLETS: PaymentInstitution[] = [
  { code: 'tng', name: "Touch 'n Go eWallet", type: 'EWALLET' },
  { code: 'grabpay', name: 'GrabPay', type: 'EWALLET' },
  { code: 'boost', name: 'Boost', type: 'EWALLET' },
  { code: 'shopeepay', name: 'ShopeePay', type: 'EWALLET' },
  { code: 'mae', name: 'MAE by Maybank', type: 'EWALLET' },
  { code: 'bigpay', name: 'BigPay', type: 'EWALLET' },
  { code: 'setel', name: 'Setel', type: 'EWALLET' },
  { code: 'merchantrade', name: 'Merchantrade Money', type: 'EWALLET' },
  { code: 'yippiepay', name: 'YippiePay (Finexus)', type: 'EWALLET' },
  { code: 'cimbocto', name: 'CIMB Octo / GoPayz', type: 'EWALLET' },
  { code: 'duitnow', name: 'DuitNow ID（手机号）', type: 'EWALLET' },
  { code: 'alipay', name: 'Alipay', type: 'EWALLET' },
  { code: 'wise', name: 'Wise', type: 'EWALLET' },
];

export const MALAYSIA_PAYMENT_INSTITUTIONS = [...MALAYSIA_BANKS, ...MALAYSIA_EWALLETS];

export function isKnownInstitution(type: 'BANK' | 'EWALLET', name: string): boolean {
  const list = type === 'BANK' ? MALAYSIA_BANKS : MALAYSIA_EWALLETS;
  return list.some((item) => item.name === name);
}

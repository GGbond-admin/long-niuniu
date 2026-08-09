/** 机构展示元数据：logo 文件码 + 品牌色（logo 缺失时占位） */
export type InstitutionMeta = {
  code: string;
  names: string[];
  short: string;
  color: string;
  textColor?: string;
  logo?: string; // /institutions/{code}.svg
};

export const INSTITUTION_META: InstitutionMeta[] = [
  { code: 'maybank', names: ['Maybank Berhad', 'Maybank'], short: 'MBB', color: '#FFD100', textColor: '#1a1a1a', logo: '/institutions/maybank.svg' },
  { code: 'mae', names: ['MAE by Maybank', 'MAE'], short: 'MAE', color: '#FFD100', textColor: '#1a1a1a', logo: '/institutions/mae.svg' },
  { code: 'cimb', names: ['CIMB Bank Berhad', 'CIMB Bank', 'CIMB'], short: 'CIMB', color: '#ED1C24', logo: '/institutions/cimb.svg' },
  { code: 'cimbocto', names: ['CIMB Octo / GoPayz', 'GoPayz', 'CIMB Octo'], short: 'GZ', color: '#ED1C24', logo: '/institutions/cimbocto.svg' },
  { code: 'public', names: ['Public Bank Berhad', 'Public Bank', 'PBe'], short: 'PBB', color: '#E31837', logo: '/institutions/public.svg' },
  { code: 'rhb', names: ['RHB Bank Berhad', 'RHB'], short: 'RHB', color: '#0066B3', logo: '/institutions/rhb.svg' },
  { code: 'hlb', names: ['Hong Leong Bank Berhad', 'Hong Leong Bank', 'Hong Leong'], short: 'HLB', color: '#1B4F9C', logo: '/institutions/hlb.svg' },
  { code: 'ambank', names: ['AmBank Malaysia Berhad', 'AmBank'], short: 'AM', color: '#E31837', logo: '/institutions/ambank.svg' },
  { code: 'affin', names: ['Affin Bank Berhad', 'Affin Bank', 'Affin'], short: 'AF', color: '#003DA5', logo: '/institutions/affin.svg' },
  { code: 'alliance', names: ['Alliance Bank Malaysia Berhad', 'Alliance Bank', 'Alliance'], short: 'AB', color: '#00A651', logo: '/institutions/alliance.svg' },
  { code: 'bsn', names: ['Bank Simpanan Nasional Berhad', 'BSN'], short: 'BSN', color: '#F7941D', logo: '/institutions/bsn.svg' },
  { code: 'bankislam', names: ['Bank Islam Malaysia Berhad', 'Bank Islam'], short: 'BI', color: '#006B3F', logo: '/institutions/bankislam.svg' },
  { code: 'bankrakyat', names: ['Bank Kerjasama Rakyat Malaysia Berhad', 'Bank Rakyat'], short: 'BR', color: '#C8102E', logo: '/institutions/bankrakyat.svg' },
  { code: 'muamalat', names: ['Bank Muamalat Malaysia Berhad', 'Bank Muamalat'], short: 'BM', color: '#006633', logo: '/institutions/muamalat.svg' },
  { code: 'agrobank', names: ['Agrobank'], short: 'AG', color: '#6B8E23', logo: '/institutions/agrobank.svg' },
  { code: 'ocbc', names: ['OCBC Bank Berhad', 'OCBC'], short: 'OCBC', color: '#EE2E24', logo: '/institutions/ocbc.svg' },
  { code: 'uob', names: ['United Overseas Bank Berhad (UOB)', 'UOB'], short: 'UOB', color: '#1B3E8C', logo: '/institutions/uob.svg' },
  { code: 'hsbc', names: ['HSBC Bank Malaysia Berhad', 'HSBC'], short: 'HSBC', color: '#DB0011', logo: '/institutions/hsbc.svg' },
  { code: 'sc', names: ['Standard Chartered Bank Malaysia Berhad', 'Standard Chartered'], short: 'SC', color: '#0072AA', logo: '/institutions/sc.svg' },
  { code: 'citi', names: ['Citibank Berhad', 'Citibank'], short: 'CITI', color: '#003B70', logo: '/institutions/citi.svg' },
  { code: 'alrajhi', names: ['Al-Rajhi Bank', 'Al-Rajhi'], short: 'AR', color: '#7A1F2B' },
  { code: 'mbsb', names: ['MBSB Bank Berhad', 'MBSB'], short: 'MBSB', color: '#00563F', logo: '/institutions/mbsb.svg' },
  { code: 'boc', names: ['Bank of China (M) Berhad', 'Bank of China'], short: 'BOC', color: '#A71E32' },
  { code: 'icbc', names: ['Industrial and Commercial Bank of China (M) Berhad', 'ICBC'], short: 'ICBC', color: '#C8102E' },
  { code: 'ccb', names: ['China Construction Bank (Malaysia)', 'CCB'], short: 'CCB', color: '#003B70' },
  { code: 'gxbank', names: ['GX Bank'], short: 'GX', color: '#111111', textColor: '#F5C451', logo: '/institutions/gxbank.svg' },
  { code: 'aeonbank', names: ['AEON Bank'], short: 'AEON', color: '#8C1D40', logo: '/institutions/aeonbank.svg' },
  { code: 'boostbank', names: ['Boost Bank'], short: 'BB', color: '#E60012', logo: '/institutions/boostbank.svg' },
  { code: 'tng', names: ["Touch 'n Go eWallet", "Touch 'n Go", 'Touch n Go', 'TNG'], short: 'TnG', color: '#00A3E0', logo: '/institutions/tng.svg' },
  { code: 'grabpay', names: ['GrabPay', 'Grab'], short: 'Grab', color: '#00B14F', logo: '/institutions/grabpay.svg' },
  { code: 'boost', names: ['Boost'], short: 'Boost', color: '#E60012', logo: '/institutions/boost.svg' },
  { code: 'shopeepay', names: ['ShopeePay', 'Shopee'], short: 'SP', color: '#EE4D2D', logo: '/institutions/shopeepay.svg' },
  { code: 'bigpay', names: ['BigPay'], short: 'BP', color: '#FF6B00' },
  { code: 'setel', names: ['Setel'], short: 'Setel', color: '#00A651', logo: '/institutions/setel.svg' },
  { code: 'merchantrade', names: ['Merchantrade Money'], short: 'MM', color: '#0057A8' },
  { code: 'yippiepay', names: ['YippiePay (Finexus)', 'YippiePay', 'Finexus'], short: 'YP', color: '#6C2BD9' },
  { code: 'duitnow', names: ['DuitNow ID（手机号）', 'DuitNow'], short: 'DN', color: '#E31837' },
  { code: 'alipay', names: ['Alipay'], short: 'Ali', color: '#1677FF', logo: '/institutions/alipay.svg' },
  { code: 'wise', names: ['Wise'], short: 'Wise', color: '#9FE870', textColor: '#163300' },
  { code: 'kfh', names: ['Kuwait Finance House'], short: 'KFH', color: '#003D6B', logo: '/institutions/kfh.svg' },
  { code: 'bofa', names: ['Bank of America (M) Berhad'], short: 'BoA', color: '#012169' },
  { code: 'deutsche', names: ['Deutsche Bank (Malaysia) Berhad'], short: 'DB', color: '#0018A8', logo: '/institutions/deutsche.svg' },
  { code: 'jpmorgan', names: ['JP Morgan Chase Bank Berhad'], short: 'JPM', color: '#117ACA' },
  { code: 'mizuho', names: ['Mizuho Bank (Malaysia) Berhad'], short: 'MZ', color: '#1A3C6E' },
  { code: 'mufg', names: ['MUFG Bank (Malaysia) Berhad'], short: 'MUFG', color: '#E60012' },
  { code: 'smbc', names: ['Sumitomo Mitsui Banking Corporation (M) Berhad'], short: 'SMBC', color: '#0066B3' },
  { code: 'bnp', names: ['BNP Paribas Malaysia Berhad'], short: 'BNP', color: '#00915A', logo: '/institutions/bnp.svg' },
];

function normalize(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ');
}

export function resolveInstitutionMeta(institutionName: string): InstitutionMeta {
  const needle = normalize(institutionName);
  if (!needle) {
    return { code: 'unknown', names: [institutionName], short: 'BK', color: '#3f3f46' };
  }

  // 1) exact name match
  const exact = INSTITUTION_META.find((item) =>
    item.names.some((name) => normalize(name) === needle),
  );
  if (exact) return exact;

  // 2) longer aliases first for prefix/containment (avoid short false positives like CIN→CIMB)
  const ranked = [...INSTITUTION_META].flatMap((item) =>
    item.names
      .map((name) => normalize(name))
      .filter((name) => name.length >= 4)
      .map((name) => ({ item, name })),
  );
  ranked.sort((a, b) => b.name.length - a.name.length);

  const contained = ranked.find(
    ({ name }) => needle === name || needle.includes(name) || name.includes(needle),
  );
  if (contained) return contained.item;

  const short = institutionName
    .replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 2))
    .join('')
    .slice(0, 4)
    .toUpperCase() || 'BK';

  return {
    code: 'unknown',
    names: [institutionName],
    short,
    color: '#3f3f46',
  };
}

export const SELECTED_WITHDRAW_ACCOUNT_KEY = 'withdraw-selected-account-id';

export function readSelectedWithdrawAccountId(): string {
  try {
    return sessionStorage.getItem(SELECTED_WITHDRAW_ACCOUNT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeSelectedWithdrawAccountId(id: string) {
  try {
    sessionStorage.setItem(SELECTED_WITHDRAW_ACCOUNT_KEY, id);
  } catch {
    // ignore
  }
}

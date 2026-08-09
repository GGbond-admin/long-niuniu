export type AvatarCategory = 'default' | 'beauty' | 'car' | 'wealth' | 'cute' | 'alt' | 'glam';

export type PresetAvatar = {
  id: string;
  category: AvatarCategory;
  label: string;
  /** 内置路径，仅允许白名单 */
  url: string;
};

export const DEFAULT_AVATAR_URL = '/avatars/nft-01.jpg';

export const AVATAR_CATEGORIES: Array<{ key: AvatarCategory | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'beauty', label: '美女' },
  { key: 'default', label: '默认' },
  { key: 'glam', label: '魅力' },
  { key: 'car', label: '豪车' },
  { key: 'wealth', label: '财神' },
  { key: 'cute', label: '可爱' },
  { key: 'alt', label: '非主流' },
];

/** 系统内置头像（用户仅能从此列表选择） */
export const PRESET_AVATARS: PresetAvatar[] = [
  // 美女（优先展示）
  { id: 'beauty-01', category: 'beauty', label: '美女 1', url: '/avatars/beauty-01.jpg' },
  { id: 'beauty-02', category: 'beauty', label: '美女 2', url: '/avatars/beauty-02.jpg' },
  { id: 'beauty-03', category: 'beauty', label: '美女 3', url: '/avatars/beauty-03.jpg' },
  { id: 'beauty-04', category: 'beauty', label: '美女 4', url: '/avatars/beauty-04.jpg' },
  { id: 'beauty-05', category: 'beauty', label: '美女 5', url: '/avatars/beauty-05.jpg' },
  { id: 'beauty-06', category: 'beauty', label: '美女 6', url: '/avatars/beauty-06.jpg' },
  { id: 'beauty-07', category: 'beauty', label: '美女 7', url: '/avatars/beauty-07.jpg' },
  { id: 'beauty-08', category: 'beauty', label: '美女 8', url: '/avatars/beauty-08.jpg' },
  { id: 'beauty-09', category: 'beauty', label: '美女 9', url: '/avatars/beauty-09.jpg' },
  { id: 'beauty-10', category: 'beauty', label: '美女 10', url: '/avatars/beauty-10.jpg' },
  { id: 'beauty-11', category: 'beauty', label: '美女 11', url: '/avatars/beauty-11.jpg' },
  { id: 'beauty-12', category: 'beauty', label: '美女 12', url: '/avatars/beauty-12.jpg' },
  { id: 'beauty-13', category: 'beauty', label: '美女 13', url: '/avatars/beauty-13.jpg' },
  { id: 'beauty-14', category: 'beauty', label: '美女 14', url: '/avatars/beauty-14.jpg' },
  { id: 'beauty-15', category: 'beauty', label: '美女 15', url: '/avatars/beauty-15.jpg' },
  { id: 'beauty-16', category: 'beauty', label: '美女 16', url: '/avatars/beauty-16.jpg' },

  { id: 'nft-01', category: 'default', label: '黑金潮男', url: '/avatars/nft-01.jpg' },
  { id: 'nft-02', category: 'default', label: '银发潮人', url: '/avatars/nft-02.jpg' },
  { id: 'nft-03', category: 'default', label: '都市丽人', url: '/avatars/nft-03.jpg' },
  { id: 'nft-04', category: 'default', label: '墨镜型男', url: '/avatars/nft-04.jpg' },
  { id: 'nft-05', category: 'default', label: '耳机少年', url: '/avatars/nft-05.jpg' },
  { id: 'nft-06', category: 'default', label: '黑金西装', url: '/avatars/nft-06.jpg' },
  { id: 'nft-07', category: 'default', label: '红酒佳人', url: '/avatars/nft-07.jpg' },
  { id: 'nft-08', category: 'default', label: '金框潮男', url: '/avatars/nft-08.jpg' },
  { id: 'car-01', category: 'car', label: '豪车 1', url: '/avatars/car-01.jpg' },
  { id: 'car-02', category: 'car', label: '豪车 2', url: '/avatars/car-02.jpg' },
  { id: 'car-03', category: 'car', label: '豪车 3', url: '/avatars/car-03.jpg' },
  { id: 'car-04', category: 'car', label: '豪车 4', url: '/avatars/car-04.jpg' },
  { id: 'wealth-01', category: 'wealth', label: '财神 1', url: '/avatars/wealth-01.jpg' },
  { id: 'wealth-02', category: 'wealth', label: '财神 2', url: '/avatars/wealth-02.jpg' },
  { id: 'wealth-03', category: 'wealth', label: '财神 3', url: '/avatars/wealth-03.jpg' },
  { id: 'cute-01', category: 'cute', label: '可爱 1', url: '/avatars/cute-01.jpg' },
  { id: 'cute-02', category: 'cute', label: '可爱 2', url: '/avatars/cute-02.jpg' },
  { id: 'cute-03', category: 'cute', label: '可爱 3', url: '/avatars/cute-03.jpg' },
  { id: 'cute-04', category: 'cute', label: '可爱 4', url: '/avatars/cute-04.jpg' },
  { id: 'alt-01', category: 'alt', label: '非主流 1', url: '/avatars/alt-01.jpg' },
  { id: 'alt-02', category: 'alt', label: '非主流 2', url: '/avatars/alt-02.jpg' },
  { id: 'alt-03', category: 'alt', label: '非主流 3', url: '/avatars/alt-03.jpg' },
  { id: 'alt-04', category: 'alt', label: '非主流 4', url: '/avatars/alt-04.jpg' },
  { id: 'alt-05', category: 'alt', label: '非主流 5', url: '/avatars/alt-05.jpg' },
  { id: 'glam-01', category: 'glam', label: '魅力 1', url: '/avatars/glam-01.jpg' },
  { id: 'glam-02', category: 'glam', label: '魅力 2', url: '/avatars/glam-02.jpg' },
  { id: 'glam-03', category: 'glam', label: '魅力 3', url: '/avatars/glam-03.jpg' },
  { id: 'glam-04', category: 'glam', label: '魅力 4', url: '/avatars/glam-04.jpg' },
  { id: 'glam-05', category: 'glam', label: '魅力 5', url: '/avatars/glam-05.jpg' },
];

const ALLOWED = new Set(PRESET_AVATARS.map((item) => item.url));
// 兼容旧默认 logo 路径（文件已替换为 3D 形象）
ALLOWED.add('/avatars/default.jpg');

export function isPresetAvatarUrl(url: string | null | undefined): boolean {
  return !!url && ALLOWED.has(url);
}

export function avatarByUrl(url: string | null | undefined) {
  return PRESET_AVATARS.find((item) => item.url === url) ?? null;
}

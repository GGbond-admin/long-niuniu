/** 与 Mini App 内置头像白名单保持一致（仅允许这些路径） */
export const PRESET_AVATAR_URLS = [
  '/avatars/beauty-01.jpg',
  '/avatars/beauty-02.jpg',
  '/avatars/beauty-03.jpg',
  '/avatars/beauty-04.jpg',
  '/avatars/beauty-05.jpg',
  '/avatars/beauty-06.jpg',
  '/avatars/beauty-07.jpg',
  '/avatars/beauty-08.jpg',
  '/avatars/beauty-09.jpg',
  '/avatars/beauty-10.jpg',
  '/avatars/beauty-11.jpg',
  '/avatars/beauty-12.jpg',
  '/avatars/beauty-13.jpg',
  '/avatars/beauty-14.jpg',
  '/avatars/beauty-15.jpg',
  '/avatars/beauty-16.jpg',
  '/avatars/nft-01.jpg',
  '/avatars/nft-02.jpg',
  '/avatars/nft-03.jpg',
  '/avatars/nft-04.jpg',
  '/avatars/nft-05.jpg',
  '/avatars/nft-06.jpg',
  '/avatars/nft-07.jpg',
  '/avatars/nft-08.jpg',
  '/avatars/default.jpg',
  '/avatars/car-01.jpg',
  '/avatars/car-02.jpg',
  '/avatars/car-03.jpg',
  '/avatars/car-04.jpg',
  '/avatars/wealth-01.jpg',
  '/avatars/wealth-02.jpg',
  '/avatars/wealth-03.jpg',
  '/avatars/cute-01.jpg',
  '/avatars/cute-02.jpg',
  '/avatars/cute-03.jpg',
  '/avatars/cute-04.jpg',
  '/avatars/alt-01.jpg',
  '/avatars/alt-02.jpg',
  '/avatars/alt-03.jpg',
  '/avatars/alt-04.jpg',
  '/avatars/alt-05.jpg',
  '/avatars/glam-01.jpg',
  '/avatars/glam-02.jpg',
  '/avatars/glam-03.jpg',
  '/avatars/glam-04.jpg',
  '/avatars/glam-05.jpg',
] as const;

export type PresetAvatarUrl = (typeof PRESET_AVATAR_URLS)[number];

export function isPresetAvatarUrl(url: string): url is PresetAvatarUrl {
  return (PRESET_AVATAR_URLS as readonly string[]).includes(url);
}

/** 从系统头像中随机挑选；优先避开房间内已占用的头像 */
export function pickRandomPresetAvatar(used: Iterable<string> = []): PresetAvatarUrl {
  const taken = new Set(
    [...used].filter((url): url is string => typeof url === 'string' && url.length > 0),
  );
  const unused = PRESET_AVATAR_URLS.filter((url) => !taken.has(url));
  const pool = unused.length > 0 ? unused : [...PRESET_AVATAR_URLS];
  return pool[Math.floor(Math.random() * pool.length)]!;
}

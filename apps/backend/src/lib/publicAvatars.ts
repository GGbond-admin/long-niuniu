import { resolve, sep } from 'node:path';

export const PUBLIC_AVATAR_FILENAME = /^[0-9a-f-]{36}\.(?:jpg|png|webp)$/;

export const PUBLIC_AVATAR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export function isPublicAvatarFilename(value: string) {
  return PUBLIC_AVATAR_FILENAME.test(value);
}

export function publicAvatarUrl(filename: string) {
  return `/api/public/avatars/${filename}`;
}

const PUBLIC_AVATAR_URL = /^\/api\/public\/avatars\/([0-9a-f-]{36}\.(?:jpg|png|webp))$/;

export function parsePublicAvatarFilename(url: string) {
  const match = PUBLIC_AVATAR_URL.exec(url.trim());
  return match?.[1] ?? null;
}

export function isPublicAvatarUrl(url: string) {
  return parsePublicAvatarFilename(url) !== null;
}

export function resolvePublicAvatarFile(uploadDir: string, filename: string) {
  if (!isPublicAvatarFilename(filename)) return null;
  const root = resolve(uploadDir, 'avatars');
  const path = resolve(root, filename);
  const relative = path.slice(root.length);
  if (!relative.startsWith(sep) || relative.includes(`..${sep}`) || relative.includes(`${sep}..`)) {
    return null;
  }
  return path;
}

export function resolvePublicAvatarOwnerFile(uploadDir: string, filename: string) {
  const path = resolvePublicAvatarFile(uploadDir, filename);
  return path ? `${path}.owner` : null;
}

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

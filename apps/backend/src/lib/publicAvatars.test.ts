import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isPublicAvatarFilename,
  publicAvatarUrl,
  resolvePublicAvatarFile,
} from './publicAvatars.js';

describe('publicAvatars', () => {
  it('only accepts uuid image names', () => {
    expect(isPublicAvatarFilename('7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg')).toBe(true);
    expect(isPublicAvatarFilename('7c9e6679-7425-40de-944b-e07fc1f90ae7.png')).toBe(true);
    expect(isPublicAvatarFilename('7c9e6679-7425-40de-944b-e07fc1f90ae7.webp')).toBe(true);
    expect(isPublicAvatarFilename('7c9e6679-7425-40de-944b-e07fc1f90ae7.pdf')).toBe(false);
    expect(isPublicAvatarFilename('../secret.jpg')).toBe(false);
    expect(isPublicAvatarFilename('avatars/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg')).toBe(false);
  });

  it('keeps files inside the avatars directory', () => {
    const filename = '7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg';
    const path = resolvePublicAvatarFile('/tmp/uploads', filename);
    expect(path).toBe(resolve('/tmp/uploads/avatars', filename));
    expect(path?.includes(`${sep}..${sep}`) ?? false).toBe(false);
    expect(publicAvatarUrl(filename)).toBe(`/api/public/avatars/${filename}`);
    expect(resolvePublicAvatarFile('/tmp/uploads', '../etc/passwd')).toBeNull();
  });
});

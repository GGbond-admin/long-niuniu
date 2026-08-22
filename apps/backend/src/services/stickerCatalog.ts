import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prisma } from '../lib/prisma.js';

export type BuiltinSticker = {
  name: string;
  url: string;
  sortOrder: number;
};

const MANIFEST_PATH = fileURLToPath(
  new URL('../../../miniapp/public/stickers/manifest.json', import.meta.url),
);

const PUBLIC_STICKER_PATH =
  /^\/api\/public\/stickers\/[0-9a-f-]{36}\.(?:gif|jpg|jpeg|png|webp)$/i;
const BUNDLED_STICKER_PATH = /^\/stickers\/[A-Za-z0-9._-]+\.(?:gif|jpg|jpeg|png|webp)$/i;

export function isAllowedStickerUrl(value: string): boolean {
  const url = value.trim();
  if (!url) return false;
  if (PUBLIC_STICKER_PATH.test(url) || BUNDLED_STICKER_PATH.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function nextStickerSortOrder(maxSortOrder: number | null | undefined): number {
  const current = Number(maxSortOrder ?? 0);
  if (!Number.isFinite(current)) return 10;
  return Math.max(0, Math.trunc(current)) + 10;
}

export function builtinSortPatches(
  existing: Array<{ id: string; url: string; sortOrder: number }>,
  manifest: BuiltinSticker[],
): Array<{ id: string; sortOrder: number }> {
  const byUrl = new Map(existing.map((item) => [item.url, item]));
  const patches: Array<{ id: string; sortOrder: number }> = [];
  for (const item of manifest) {
    const row = byUrl.get(item.url);
    if (row && row.sortOrder === 0 && item.sortOrder !== 0) {
      patches.push({ id: row.id, sortOrder: item.sortOrder });
    }
  }
  return patches;
}

export function missingBuiltinStickers(
  existingUrls: string[],
  manifest: BuiltinSticker[],
): BuiltinSticker[] {
  const have = new Set(existingUrls);
  return manifest.filter((item) => !have.has(item.url));
}

export async function loadBuiltinStickerManifest(): Promise<BuiltinSticker[]> {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Array<{
      name?: string;
      url?: string;
      sortOrder?: number;
    }>;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item, index) => {
      const name = String(item.name ?? '').trim();
      const url = String(item.url ?? '').trim();
      if (!name || !isAllowedStickerUrl(url)) return [];
      const sortOrder =
        typeof item.sortOrder === 'number' && Number.isFinite(item.sortOrder)
          ? Math.trunc(item.sortOrder)
          : index + 1;
      return [{ name, url, sortOrder }];
    });
  } catch {
    return [];
  }
}

let catalogReady = false;

/** 补齐内置贴纸，并只纠正从未排过序（sortOrder=0）的记录。 */
export async function ensureStickerCatalog(): Promise<void> {
  if (catalogReady) return;
  const manifest = await loadBuiltinStickerManifest();
  const existing = await prisma.stickerAsset.findMany({
    select: { id: true, url: true, sortOrder: true },
  });
  const creates = missingBuiltinStickers(
    existing.map((item) => item.url),
    manifest,
  );
  const patches = builtinSortPatches(existing, manifest);
  if (creates.length > 0) {
    await prisma.stickerAsset.createMany({
      data: creates.map((item) => ({
        name: item.name,
        url: item.url,
        sortOrder: item.sortOrder,
        status: 'ACTIVE',
      })),
    });
  }
  for (const patch of patches) {
    await prisma.stickerAsset.update({
      where: { id: patch.id },
      data: { sortOrder: patch.sortOrder },
    });
  }
  catalogReady = true;
}

export async function listActiveStickers() {
  await ensureStickerCatalog();
  return prisma.stickerAsset.findMany({
    where: { status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, url: true, sortOrder: true },
  });
}

export async function listAdminStickers() {
  await ensureStickerCatalog();
  return prisma.stickerAsset.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function reorderStickers(ids: string[]) {
  const unique = [...new Set(ids)];
  await prisma.$transaction(
    unique.map((id, index) =>
      prisma.stickerAsset.update({
        where: { id },
        data: { sortOrder: (index + 1) * 10 },
      }),
    ),
  );
}

export function resetStickerCatalogCache() {
  catalogReady = false;
}

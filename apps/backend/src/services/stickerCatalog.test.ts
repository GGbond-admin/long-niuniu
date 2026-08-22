import { describe, expect, it } from 'vitest';
import {
  builtinSortPatches,
  isAllowedStickerUrl,
  missingBuiltinStickers,
  nextStickerSortOrder,
} from './stickerCatalog.js';

describe('贴纸目录', () => {
  it('允许站内路径和 http(s)，拒绝其它协议', () => {
    expect(isAllowedStickerUrl('/stickers/niupi.gif')).toBe(true);
    expect(isAllowedStickerUrl('/api/public/stickers/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.gif')).toBe(
      true,
    );
    expect(isAllowedStickerUrl('https://cdn.example.com/a.webp')).toBe(true);
    expect(isAllowedStickerUrl('/etc/passwd')).toBe(false);
    expect(isAllowedStickerUrl('javascript:alert(1)')).toBe(false);
  });

  it('新贴纸排在现有最大序号之后', () => {
    expect(nextStickerSortOrder(null)).toBe(10);
    expect(nextStickerSortOrder(33)).toBe(43);
  });

  it('只修正从未排过序的内置贴纸', () => {
    const manifest = [
      { name: '牛啤', url: '/stickers/niupi.gif', sortOrder: 10 },
      { name: '掌声', url: '/stickers/applause.gif', sortOrder: 1 },
    ];
    expect(
      builtinSortPatches(
        [
          { id: 'a', url: '/stickers/applause.gif', sortOrder: 0 },
          { id: 'b', url: '/stickers/niupi.gif', sortOrder: 88 },
        ],
        manifest,
      ),
    ).toEqual([{ id: 'a', sortOrder: 1 }]);
  });

  it('补齐清单里缺失的内置贴纸', () => {
    expect(
      missingBuiltinStickers(['/stickers/niupi.gif'], [
        { name: '牛啤', url: '/stickers/niupi.gif', sortOrder: 10 },
        { name: '掌声', url: '/stickers/applause.gif', sortOrder: 1 },
      ]),
    ).toEqual([{ name: '掌声', url: '/stickers/applause.gif', sortOrder: 1 }]);
  });
});

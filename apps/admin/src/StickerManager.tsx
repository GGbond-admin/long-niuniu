import { useEffect, useState } from 'react';
import { patch, post, request, uploadAdminFile } from './api';

type Sticker = {
  id: string;
  name: string;
  url: string;
  sortOrder: number;
  status: 'ACTIVE' | 'DISABLED' | string;
};

export default function StickerManager() {
  const [items, setItems] = useState<Sticker[]>([]);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load() {
    const result = await request<{ items: Sticker[] }>('/api/admin/stickers');
    setItems(result.items);
  }

  useEffect(() => {
    void load().catch(() => setMessage('贴纸列表加载失败'));
  }, []);

  async function create() {
    if (!file || !name.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const uploaded = await uploadAdminFile<{ url: string }>('/api/admin/uploads/sticker', file);
      await post('/api/admin/stickers', { name: name.trim(), url: uploaded.url });
      setName('');
      setFile(null);
      setMessage('已添加贴纸，玩家打开表情面板即可看到');
      await load();
    } catch (error) {
      setMessage((error as Error).message || '添加失败');
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    const ordered = items.slice();
    const [current] = ordered.splice(index, 1);
    if (!current) return;
    ordered.splice(next, 0, current);
    setItems(ordered);
    setBusy(true);
    try {
      const result = await post<{ items: Sticker[] }>('/api/admin/stickers/reorder', {
        ids: ordered.map((item) => item.id),
      });
      setItems(result.items);
    } catch (error) {
      setMessage((error as Error).message || '排序失败');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: Sticker) {
    setBusy(true);
    try {
      await patch(`/api/admin/stickers/${item.id}`, {
        status: item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
      });
      await load();
    } catch (error) {
      setMessage((error as Error).message || '更新失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel" style={{ padding: '12px 16px', marginBottom: 14 }}>
        <p style={{ margin: 0, color: '#98988e', fontSize: 12, lineHeight: 1.55 }}>
          互动群和客服会话共用这套贴纸。顺序按这里的上下移动生效：先动画、后静态更顺手。新贴纸会排到最后。
        </p>
      </section>
      <section className="panel inline-form sticker-form">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="贴纸名称，例如 牛啤"
          maxLength={100}
        />
        <label className="sticker-file">
          <input
            type="file"
            accept="image/gif,image/jpeg,image/png,image/webp"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <span>{file ? file.name : '选择 GIF / JPG / PNG / WEBP'}</span>
        </label>
        <button
          className="primary small"
          type="button"
          disabled={busy || !name.trim() || !file}
          onClick={() => void create()}
        >
          {busy ? '处理中…' : '添加贴纸'}
        </button>
      </section>
      {message && <p className="sticker-admin-msg">{message}</p>}
      <div className="sticker-admin-grid">
        {items.map((item, index) => (
          <article className="panel" key={item.id}>
            <img src={item.url} alt={item.name} />
            <strong>{item.name}</strong>
            <small>{item.status === 'ACTIVE' ? '使用中' : '已下架'}</small>
            <footer>
              <button type="button" disabled={busy || index === 0} onClick={() => void move(index, -1)}>
                上移
              </button>
              <button
                type="button"
                disabled={busy || index === items.length - 1}
                onClick={() => void move(index, 1)}
              >
                下移
              </button>
              <button type="button" disabled={busy} onClick={() => void toggle(item)}>
                {item.status === 'ACTIVE' ? '下架' : '上架'}
              </button>
            </footer>
          </article>
        ))}
      </div>
      {items.length === 0 && (
        <div className="empty">
          <b>◇</b>
          <span>还没有贴纸。上传一张动图或图片后，玩家就能在贴纸页点选发送。</span>
        </div>
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { patch, post, request, rm } from './api';

type Row = Record<string, any>;

function toCents(value: string) {
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error('金额格式无效，请输入如 12.50');
  const [integer, decimal = ''] = cleaned.split('.');
  return String(BigInt(integer || '0') * 100n + BigInt((decimal + '00').slice(0, 2)));
}

function centsToRm(cents: string | number | bigint | undefined) {
  if (cents === undefined || cents === null || cents === '') return '';
  return rm(cents);
}

function roomLabel(room: Row | null | undefined) {
  if (!room) return '未绑定群';
  const code = room.gameCode ? ` · ${room.gameCode}` : '';
  return `${room.title ?? '互动群'}${code}`;
}

function avatarSrc(user: Row | null | undefined) {
  const path = user?.avatarUrl;
  // 系统内置头像优先走本地域名 /avatars（admin 已镜像 miniapp 资源）
  if (typeof path === 'string' && path.startsWith('/avatars/')) return path;
  return user?.avatarDisplayUrl || path || '';
}

function PlayerAvatar({ user, name }: { user?: Row | null; name?: string }) {
  const src = avatarSrc(user);
  if (src) {
    return <img className="vp-avatar" src={src} alt="" loading="lazy" />;
  }
  const initial = (name || user?.nickname || '?').slice(0, 1);
  return <span className="vp-avatar fallback" aria-hidden>{initial}</span>;
}

type Caps = {
  enabled: boolean;
  canJoin: boolean;
  canChat: boolean;
  canBid: boolean;
  canBet: boolean;
  canAllIn: boolean;
  canBanker: boolean;
  canContinue: boolean;
  canThrowDice: boolean;
  canGroupPacket: boolean;
  canClaimGroupPacket: boolean;
  canClaimSim: boolean;
};

const defaultCaps: Caps = {
  enabled: true,
  canJoin: true,
  canChat: true,
  canBid: true,
  canBet: true,
  canAllIn: false,
  canBanker: true,
  canContinue: false,
  canThrowDice: true,
  canGroupPacket: false,
  canClaimGroupPacket: true,
  canClaimSim: true,
};

const capGroups: Array<{ title: string; items: Array<[keyof Caps, string]> }> = [
  {
    title: '基础',
    items: [
      ['enabled', '启用'],
      ['canJoin', '可入群'],
      ['canChat', '可聊天'],
    ],
  },
  {
    title: '对局',
    items: [
      ['canBid', '可竞标'],
      ['canBanker', '可做庄'],
      ['canBet', '可下注'],
      ['canAllIn', '可梭哈'],
      ['canContinue', '可续庄'],
      ['canThrowDice', '可掷骰'],
    ],
  },
  {
    title: '红包',
    items: [
      ['canGroupPacket', '可发群红包'],
      ['canClaimGroupPacket', '可抢群红包'],
      ['canClaimSim', '可自动认尾包'],
    ],
  },
];

type EditDraft = Caps & {
  nickname: string;
  roomId: string;
  bidWeight: string;
  betRatioMin: string;
  betRatioMax: string;
  targetBalanceRm: string;
};

function draftFromItem(item: Row): EditDraft {
  return {
    nickname: item.user?.nickname ?? '',
    roomId: item.roomId ?? item.room?.id ?? '',
    enabled: Boolean(item.enabled),
    canJoin: Boolean(item.canJoin),
    canChat: Boolean(item.canChat),
    canBid: Boolean(item.canBid),
    canBet: Boolean(item.canBet),
    canAllIn: Boolean(item.canAllIn),
    canBanker: Boolean(item.canBanker),
    canContinue: Boolean(item.canContinue),
    canThrowDice: Boolean(item.canThrowDice),
    canGroupPacket: Boolean(item.canGroupPacket),
    canClaimGroupPacket: Boolean(item.canClaimGroupPacket),
    canClaimSim: Boolean(item.canClaimSim),
    bidWeight: String(item.bidWeight ?? 0.7),
    betRatioMin: String(item.betRatioMin ?? 0.05),
    betRatioMax: String(item.betRatioMax ?? 0.2),
    targetBalanceRm: centsToRm(item.targetBalanceCents ?? 500_000),
  };
}

function membershipStatus(item: Row) {
  const membership = (item.user?.roomMemberships ?? []).find(
    (row: Row) => row.roomId === item.roomId,
  );
  return membership?.status === 'ACTIVE' ? '在群' : '未在群';
}

function abilitySummary(item: Row) {
  return [
    item.canBid && '竞标',
    item.canBet && '下注',
    item.canBanker && '做庄',
    item.canThrowDice && '掷骰',
    item.canChat && '聊天',
  ]
    .filter(Boolean)
    .join(' · ') || '无能力';
}

function CapGrid({
  value,
  onChange,
}: {
  value: Caps;
  onChange: (key: keyof Caps, checked: boolean) => void;
}) {
  return (
    <div className="vp-cap-groups">
      {capGroups.map((group) => (
        <div key={group.title} className="vp-cap-group">
          <div className="vp-cap-group-title">{group.title}</div>
          <div className="vp-cap-list">
            {group.items.map(([key, label]) => (
              <label key={key} className={`vp-cap${value[key] ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={value[key]}
                  onChange={(event) => onChange(key, event.target.checked)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function RoomSelect({
  rooms,
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = '请选择互动群',
}: {
  rooms: Row[];
  value: string;
  onChange: (roomId: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {!allowEmpty && !value && <option value="">{emptyLabel}</option>}
      {rooms.map((room) => (
        <option key={room.id} value={room.id}>
          {roomLabel(room)}
          {room.status === 'PAUSED' ? '（入口暂停）' : ''}
        </option>
      ))}
    </select>
  );
}

export default function VirtualPlayers({
  roomId: scopedRoomId = '',
  embedded = false,
}: {
  roomId?: string;
  embedded?: boolean;
}) {
  const [rooms, setRooms] = useState<Row[]>([]);
  const [items, setItems] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [filterRoomId, setFilterRoomId] = useState(scopedRoomId);
  const [createRoomId, setCreateRoomId] = useState(scopedRoomId);
  const [nickname, setNickname] = useState('');
  const [fundRm, setFundRm] = useState('5000');
  const [bidWeight, setBidWeight] = useState('0.7');
  const [betMin, setBetMin] = useState('0.05');
  const [betMax, setBetMax] = useState('0.2');
  const [caps, setCaps] = useState<Caps>(defaultCaps);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [actAmount, setActAmount] = useState('100');
  const [chatText, setChatText] = useState('');

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  const roomMap = useMemo(() => {
    const map = new Map<string, Row>();
    for (const room of rooms) map.set(room.id, room);
    return map;
  }, [rooms]);

  async function loadRooms() {
    const response = await request<{ items: Row[] }>('/api/admin/rooms');
    const availableRooms = scopedRoomId
      ? response.items.filter((room) => room.id === scopedRoomId)
      : response.items;
    setRooms(availableRooms);
    if (scopedRoomId) {
      setFilterRoomId(scopedRoomId);
      setCreateRoomId(scopedRoomId);
    } else if (!createRoomId && availableRooms[0]?.id) {
      setCreateRoomId(availableRooms[0].id);
    }
    return availableRooms;
  }

  async function load(preferId = selectedId, roomId = filterRoomId) {
    const effectiveRoomId = scopedRoomId || roomId;
    const query = effectiveRoomId ? `?roomId=${encodeURIComponent(effectiveRoomId)}` : '';
    const response = await request<{ items: Row[] }>(`/api/admin/virtual-players${query}`);
    setItems(response.items);
    const nextId =
      (preferId && response.items.some((item) => item.id === preferId) && preferId)
      || response.items[0]?.id
      || '';
    setSelectedId(nextId);
    const nextItem = response.items.find((item) => item.id === nextId) ?? null;
    setDraft(nextItem ? draftFromItem(nextItem) : null);
  }

  useEffect(() => {
    void (async () => {
      try {
        await loadRooms();
        await load('', scopedRoomId);
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedRoomId]);

  function selectItem(id: string) {
    setSelectedId(id);
    const item = items.find((row) => row.id === id);
    setDraft(item ? draftFromItem(item) : null);
  }

  async function changeFilter(roomId: string) {
    setFilterRoomId(roomId);
    setBusy('filter');
    setError('');
    try {
      await load('', roomId);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function run(
    name: string,
    task: () => Promise<string | void | { id?: string; roomId?: string }>,
  ) {
    setBusy(name);
    setError('');
    try {
      const result = await task();
      const preferId = typeof result === 'string' ? result : result?.id;
      const nextFilter =
        scopedRoomId ||
        (
          typeof result === 'object' && result?.roomId
            ? (
              filterRoomId && filterRoomId !== result.roomId
                ? result.roomId
                : filterRoomId
            )
            : filterRoomId
        );
      if (nextFilter !== filterRoomId) setFilterRoomId(nextFilter);
      await load(preferId || selectedId, nextFilter);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy('');
    }
  }

  function create() {
    if (!createRoomId) {
      setError('请先选择所属互动群');
      return;
    }
    void run('create', async () => {
      const fundCents = toCents(fundRm);
      const trimmed = nickname.trim();
      const created = await post<{ item: Row }>('/api/admin/virtual-players', {
        ...(trimmed ? { nickname: trimmed, autoNickname: false } : { autoNickname: true }),
        roomId: createRoomId,
        ...caps,
        bidWeight: Number(bidWeight),
        betRatioMin: Number(betMin),
        betRatioMax: Number(betMax),
        targetBalanceCents: fundCents,
        initialFundCents: fundCents,
        joinRoom: true,
      });
      setNickname('');
      return { id: created.item.id, roomId: createRoomId };
    });
  }

  function bulkToggle(enabled: boolean) {
    const effectiveRoomId = scopedRoomId || filterRoomId;
    const scopeLabel = effectiveRoomId
      ? `「${roomLabel(roomMap.get(effectiveRoomId))}」内`
      : '全部';
    const verb = enabled ? '启用' : '停用';
    if (!window.confirm(`将一键${verb}${scopeLabel}虚拟玩家，是否继续？`)) return;
    void run(enabled ? 'bulk-on' : 'bulk-off', async () => {
      await post('/api/admin/virtual-players/bulk-enabled', {
        enabled,
        ...(effectiveRoomId ? { roomId: effectiveRoomId } : {}),
      });
    });
  }

  function dressUp() {
    if (!window.confirm(filterRoomId
      ? '将为当前筛选群内全部虚拟玩家重新匹配英文名与系统头像，是否继续？'
      : '将为全部虚拟玩家重新匹配英文名与系统头像，是否继续？')) {
      return;
    }
    void run('dress-up', async () => {
      const result = await post<{ count: number; items: Row[] }>(
        '/api/admin/virtual-players/dress-up',
        filterRoomId ? { roomId: filterRoomId } : {},
      );
      return { id: selectedId || result.items[0]?.id, roomId: filterRoomId || undefined };
    });
  }

  function saveSelected() {
    if (!selected || !draft) return;
    if (!draft.roomId) {
      setError('请选择所属互动群');
      return;
    }
    void run('save', async () => {
      await patch(`/api/admin/virtual-players/${selected.id}`, {
        nickname: draft.nickname.trim(),
        roomId: draft.roomId,
        enabled: draft.enabled,
        canJoin: draft.canJoin,
        canChat: draft.canChat,
        canBid: draft.canBid,
        canBet: draft.canBet,
        canAllIn: draft.canAllIn,
        canBanker: draft.canBanker,
        canContinue: draft.canContinue,
        canThrowDice: draft.canThrowDice,
        canGroupPacket: draft.canGroupPacket,
        canClaimGroupPacket: draft.canClaimGroupPacket,
        canClaimSim: draft.canClaimSim,
        bidWeight: Number(draft.bidWeight),
        betRatioMin: Number(draft.betRatioMin),
        betRatioMax: Number(draft.betRatioMax),
        targetBalanceCents: toCents(draft.targetBalanceRm),
      });
      return { id: selected.id, roomId: draft.roomId };
    });
  }

  const selectedRoom = selected
    ? (selected.room ?? roomMap.get(selected.roomId) ?? null)
    : null;
  const createDisabled = !!busy || !createRoomId || rooms.length === 0;

  return (
    <div className={`vp-page${embedded ? ' embedded' : ''}`}>
      {error && <div className="error-box">{error}</div>}

      <section className="panel vp-create">
        <div className="panel-title">
          <div>
            <small>新建虚拟玩家</small>
            <h2>指定互动群并加入</h2>
          </div>
          <span className="vp-hint">昵称留空自动分配英文名；头像从系统内置库随机匹配（同群优先不重复）</span>
        </div>

        <div className="vp-body">
          {!rooms.length && (
            <p className="vp-tip">尚未创建互动群，请先在游戏运营中心为游戏建群。</p>
          )}
          <div className="vp-form-grid">
            {scopedRoomId ? (
              <div className="vp-fixed-room">
                <span>所属互动群</span>
                <strong>{roomLabel(rooms[0])}</strong>
              </div>
            ) : (
              <label className="vp-room-field">
                所属互动群
                <RoomSelect
                  rooms={rooms}
                  value={createRoomId}
                  onChange={setCreateRoomId}
                  emptyLabel="请选择互动群"
                />
              </label>
            )}
            <label>
              昵称（可留空）
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="留空 = 随机英文名"
              />
            </label>
            <label>
              初始 / 目标资金（RM）
              <input value={fundRm} onChange={(event) => setFundRm(event.target.value)} placeholder="5000" />
            </label>
            <label>
              竞标参与概率（0–1）
              <input value={bidWeight} onChange={(event) => setBidWeight(event.target.value)} />
            </label>
            <label>
              下注比例下限
              <input value={betMin} onChange={(event) => setBetMin(event.target.value)} />
            </label>
            <label>
              下注比例上限
              <input value={betMax} onChange={(event) => setBetMax(event.target.value)} />
            </label>
          </div>

          <div className="vp-section-label">能力开关</div>
          <CapGrid
            value={caps}
            onChange={(key, checked) => setCaps((previous) => ({ ...previous, [key]: checked }))}
          />

          <div className="vp-actions">
            <button
              type="button"
              className="primary small"
              disabled={createDisabled}
              onClick={create}
            >
              {busy === 'create' ? '创建中…' : '创建并入群（英文名+随机头像）'}
            </button>
            <button type="button" disabled={!!busy || !items.length} onClick={dressUp}>
              {busy === 'dress-up' ? '匹配中…' : filterRoomId ? '本群批量配英文名+头像' : '全部批量配英文名+头像'}
            </button>
          </div>
        </div>
      </section>

      <div className="vp-layout">
        <section className="panel">
          <div className="panel-title">
            <div>
              <small>虚拟玩家列表</small>
              <h2>共 {items.length} 人</h2>
            </div>
            <div className="vp-toolbar">
              {!scopedRoomId && (
                <label className="vp-filter">
                  <span>筛选群</span>
                  <RoomSelect
                    rooms={rooms}
                    value={filterRoomId}
                    onChange={(roomId) => void changeFilter(roomId)}
                    allowEmpty
                    emptyLabel="全部互动群"
                  />
                </label>
              )}
              <button
                type="button"
                className="primary small"
                disabled={!!busy || !items.length}
                onClick={() => bulkToggle(true)}
              >
                {busy === 'bulk-on' ? '启用中…' : '一键启用'}
              </button>
              <button
                type="button"
                disabled={!!busy || !items.length}
                onClick={() => bulkToggle(false)}
              >
                {busy === 'bulk-off' ? '停用中…' : '一键停用'}
              </button>
              <button type="button" disabled={!!busy} onClick={() => void load()}>刷新</button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>玩家</th>
                  <th>所属群</th>
                  <th>UID</th>
                  <th>余额</th>
                  <th>状态</th>
                  <th>能力</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const room = item.room ?? roomMap.get(item.roomId);
                  return (
                    <tr
                      key={item.id}
                      className={selectedId === item.id ? 'selected' : ''}
                      onClick={() => selectItem(item.id)}
                    >
                      <td>
                        <div className="vp-player-cell">
                          <PlayerAvatar user={item.user} />
                          <div>
                            <strong>{item.user?.nickname ?? '—'}</strong>
                            <small>虚拟</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <strong>{room?.title ?? '—'}</strong>
                        <small>{room?.gameCode ?? ''}</small>
                      </td>
                      <td>{item.user?.uid}</td>
                      <td className="money">RM {rm(item.user?.wallet?.availableCents ?? 0)}</td>
                      <td>
                        <span className={item.enabled ? 'vp-pill on' : 'vp-pill off'}>
                          {item.enabled ? '启用' : '停用'}
                        </span>
                        {' · '}
                        {membershipStatus(item)}
                      </td>
                      <td className="truncate">{abilitySummary(item)}</td>
                    </tr>
                  );
                })}
                {!items.length && (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty">
                        <b>◇</b>
                        <span>{filterRoomId ? '该群暂无虚拟玩家' : '尚未创建虚拟玩家'}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="panel vp-detail">
          {!selected || !draft ? (
            <div className="empty"><b>◇</b><span>选择左侧玩家进行配置</span></div>
          ) : (
            <div className="vp-body">
              <div className="panel-title">
                <div className="vp-detail-head">
                  <PlayerAvatar user={selected.user} name={draft.nickname} />
                  <div>
                    <small>能力配置</small>
                    <h2>{selected.user?.nickname}</h2>
                  </div>
                </div>
                <span className={`vp-pill ${membershipStatus(selected) === '在群' ? 'on' : 'off'}`}>
                  {membershipStatus(selected)}
                </span>
              </div>

              <div className="vp-form-grid compact">
                {scopedRoomId ? (
                  <div className="vp-fixed-room">
                    <span>所属互动群</span>
                    <strong>{roomLabel(rooms[0])}</strong>
                  </div>
                ) : (
                  <label className="vp-room-field">
                    所属互动群
                    <RoomSelect
                      rooms={rooms}
                      value={draft.roomId}
                      onChange={(roomId) => setDraft({ ...draft, roomId })}
                    />
                  </label>
                )}
                <label>
                  昵称
                  <input
                    value={draft.nickname}
                    onChange={(event) => setDraft({ ...draft, nickname: event.target.value })}
                  />
                </label>
              </div>
              <div className="vp-actions wrap">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void run('randomize', async () => {
                    await post(`/api/admin/virtual-players/${selected.id}/randomize-identity`, {
                      rename: true,
                      reavatar: true,
                    });
                    return selected.id;
                  })}
                >
                  {busy === 'randomize' ? '抽取中…' : '随机英文名+头像'}
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void run('reavatar', async () => {
                    await post(`/api/admin/virtual-players/${selected.id}/randomize-identity`, {
                      rename: false,
                      reavatar: true,
                    });
                    return selected.id;
                  })}
                >
                  只换头像
                </button>
              </div>
              {draft.roomId !== selected.roomId && (
                <p className="vp-tip">
                  保存后将改绑到「{roomLabel(roomMap.get(draft.roomId))}」；若原在群，会自动离旧群并入新群。
                </p>
              )}
              {selectedRoom && draft.roomId === selected.roomId && (
                <p className="vp-tip">当前绑定：{roomLabel(selectedRoom)}</p>
              )}

              <div className="vp-section-label">能力开关</div>
              <CapGrid
                value={draft}
                onChange={(key, checked) => setDraft({ ...draft, [key]: checked })}
              />

              <div className="vp-section-label">行为参数</div>
              <div className="vp-form-grid compact">
                <label>
                  竞标参与概率
                  <input
                    value={draft.bidWeight}
                    onChange={(event) => setDraft({ ...draft, bidWeight: event.target.value })}
                  />
                </label>
                <label>
                  下注比例下限
                  <input
                    value={draft.betRatioMin}
                    onChange={(event) => setDraft({ ...draft, betRatioMin: event.target.value })}
                  />
                </label>
                <label>
                  下注比例上限
                  <input
                    value={draft.betRatioMax}
                    onChange={(event) => setDraft({ ...draft, betRatioMax: event.target.value })}
                  />
                </label>
                <label>
                  目标余额（RM）
                  <input
                    value={draft.targetBalanceRm}
                    onChange={(event) => setDraft({ ...draft, targetBalanceRm: event.target.value })}
                  />
                </label>
              </div>

              <div className="vp-actions wrap">
                <button type="button" className="primary small" disabled={!!busy} onClick={saveSelected}>
                  {busy === 'save' ? '保存中…' : '保存配置'}
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void run('join', async () => {
                    await post(`/api/admin/virtual-players/${selected.id}/join`, {});
                  })}
                >
                  入群
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void run('leave', async () => {
                    await post(`/api/admin/virtual-players/${selected.id}/leave`, {});
                  })}
                >
                  离群
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void run('fund', async () => {
                    const amount = window.prompt('补款金额 RM', draft.targetBalanceRm || '1000');
                    if (!amount) return;
                    await post(`/api/admin/virtual-players/${selected.id}/fund`, {
                      amountCents: toCents(amount),
                      reason: '后台手动补款',
                    });
                  })}
                >
                  补款
                </button>
              </div>

              <div className="vp-divider" />

              <div className="panel-title">
                <div>
                  <small>代操作</small>
                  <h2>手动参与当前局</h2>
                </div>
              </div>
              <p className="vp-tip">操作目标为所属群「{roomLabel(selectedRoom)}」的当前局</p>
              <div className="vp-form-grid act">
                <label>
                  金额（RM）
                  <input value={actAmount} onChange={(event) => setActAmount(event.target.value)} />
                </label>
                <label>
                  聊天内容
                  <input
                    value={chatText}
                    onChange={(event) => setChatText(event.target.value)}
                    placeholder="填写后可代发言"
                  />
                </label>
              </div>
              <div className="vp-actions wrap">
                <button
                  type="button"
                  disabled={!!busy || !draft.canBid}
                  title={!draft.canBid ? '未开启可竞标' : undefined}
                  onClick={() => void run('act-bid', async () => {
                    await post(`/api/admin/virtual-players/${selected.id}/act`, {
                      action: 'bid',
                      amountCents: toCents(actAmount),
                    });
                  })}
                >
                  代竞标
                </button>
                <button
                  type="button"
                  disabled={!!busy || !draft.canBet}
                  title={!draft.canBet ? '未开启可下注' : undefined}
                  onClick={() => void run('act-bet', async () => {
                    await post(`/api/admin/virtual-players/${selected.id}/act`, {
                      action: 'bet',
                      amountCents: toCents(actAmount),
                    });
                  })}
                >
                  代下注
                </button>
                <button
                  type="button"
                  disabled={!!busy || !draft.canThrowDice}
                  title={!draft.canThrowDice ? '未开启可掷骰' : undefined}
                  onClick={() => void run('act-dice', async () => {
                    await post(`/api/admin/virtual-players/${selected.id}/act`, { action: 'dice' });
                  })}
                >
                  代掷骰
                </button>
                <button
                  type="button"
                  disabled={!!busy || !draft.canChat || !chatText.trim()}
                  title={
                    !draft.canChat
                      ? '未开启可聊天'
                      : !chatText.trim()
                        ? '请先填写聊天内容'
                        : undefined
                  }
                  onClick={() => void run('act-chat', async () => {
                    await post(`/api/admin/virtual-players/${selected.id}/act`, {
                      action: 'chat',
                      text: chatText.trim(),
                    });
                    setChatText('');
                  })}
                >
                  代发言
                </button>
              </div>
              {!chatText.trim() && draft.canChat && (
                <p className="vp-tip">代发言需先填写聊天内容</p>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

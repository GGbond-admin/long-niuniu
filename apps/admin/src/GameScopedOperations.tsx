import { useEffect, useMemo, useState } from 'react';
import { post, put, request, rm } from './api';
import GameConfigEditor from './GameConfigEditor';
import RewardConditionsForm, {
  emptyConditionDraft,
  parseConditionDraft,
  serializeConditionDraft,
  summarizeConditions,
  type RewardConditionDraft,
} from './RewardConditionsForm';

type Row = Record<string, any>;

function toCents(value: string) {
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error('金额格式无效，请输入如 12.50');
  }
  const [integer, decimal = ''] = cleaned.split('.');
  return String(
    BigInt(integer || '0') * 100n +
      BigInt((decimal + '00').slice(0, 2)),
  );
}

function Notice({ message }: { message: string }) {
  if (!message) return null;
  return <div className="game-scope-notice" role="status">{message}</div>;
}

type RuleSection = { id: string; title: string; body: string };
type RuleDraft = {
  title: string;
  summary: string;
  sections: RuleSection[];
  status: 'DRAFT' | 'PUBLISHED';
};

const emptyRules: RuleDraft = {
  title: '',
  summary: '',
  sections: [{ id: 'overview', title: '玩法概览', body: '' }],
  status: 'DRAFT',
};

function RuleDocumentEditor({ gameCode }: { gameCode: string }) {
  const [draft, setDraft] = useState<RuleDraft>(emptyRules);
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await request<{ document: Row | null }>(
      `/api/admin/games/${encodeURIComponent(gameCode)}/rules`,
    );
    const document = response.document;
    setDraft(
      document
        ? {
            title: document.title,
            summary: document.summary ?? '',
            sections: Array.isArray(document.sections)
              ? document.sections
              : emptyRules.sections,
            status: document.status,
          }
        : {
            ...emptyRules,
            title: `${gameCode} 游戏规则`,
            sections: [...emptyRules.sections],
          },
    );
    setVersion(document?.version ?? 0);
  }

  useEffect(() => {
    void load().catch((error) => setMessage((error as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameCode]);

  function updateSection(index: number, patch: Partial<RuleSection>) {
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, ...patch } : section,
      ),
    }));
  }

  async function save(status: RuleDraft['status']) {
    if (
      status === 'PUBLISHED' &&
      !window.confirm('确认发布玩家规则？玩家端将立即读取新文本；数值配置仍只在下一局生效。')
    ) {
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const response = await put<{
        document: Row;
        changes: string[];
      }>(
        `/api/admin/games/${encodeURIComponent(gameCode)}/rules`,
        { ...draft, status },
      );
      setVersion(response.document.version);
      setDraft((current) => ({ ...current, status }));
      setMessage(
        `${status === 'PUBLISHED' ? '已发布' : '草稿已保存'} · v${response.document.version}` +
          (response.changes.length
            ? ` · 变更：${response.changes.join('、')}`
            : ''),
      );
    } catch (error) {
      setMessage(`保存失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel game-rule-editor">
      <div className="panel-title">
        <div>
          <small>玩家规则说明</small>
          <h2>纯文本发布内容</h2>
        </div>
        <span className={`rule-status ${draft.status.toLowerCase()}`}>
          {draft.status === 'PUBLISHED' ? '已发布' : '草稿'} · v{version}
        </span>
      </div>
      <div className="game-rule-fields">
        <label>
          规则标题
          <input
            value={draft.title}
            maxLength={80}
            onChange={(event) =>
              setDraft({ ...draft, title: event.target.value })
            }
          />
        </label>
        <label>
          简短摘要
          <textarea
            value={draft.summary}
            maxLength={500}
            onChange={(event) =>
              setDraft({ ...draft, summary: event.target.value })
            }
          />
        </label>
      </div>
      <div className="rule-section-list">
        {draft.sections.map((section, index) => (
          <article key={`${section.id}-${index}`}>
            <header>
              <strong>章节 {index + 1}</strong>
              {draft.sections.length > 1 && (
                <button
                  type="button"
                  className="danger-text"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      sections: draft.sections.filter(
                        (_, sectionIndex) => sectionIndex !== index,
                      ),
                    })
                  }
                >
                  删除
                </button>
              )}
            </header>
            <div>
              <label>
                标识
                <input
                  value={section.id}
                  onChange={(event) =>
                    updateSection(index, { id: event.target.value })
                  }
                />
              </label>
              <label>
                标题
                <input
                  value={section.title}
                  onChange={(event) =>
                    updateSection(index, { title: event.target.value })
                  }
                />
              </label>
            </div>
            <label>
              正文
              <textarea
                value={section.body}
                maxLength={4_000}
                onChange={(event) =>
                  updateSection(index, { body: event.target.value })
                }
              />
            </label>
          </article>
        ))}
      </div>
      <footer className="rule-editor-actions">
        <button
          type="button"
          disabled={busy || draft.sections.length >= 20}
          onClick={() =>
            setDraft({
              ...draft,
              sections: [
                ...draft.sections,
                {
                  id: `section_${draft.sections.length + 1}`,
                  title: '',
                  body: '',
                },
              ],
            })
          }
        >
          ＋ 增加章节
        </button>
        <span />
        <button
          type="button"
          disabled={busy}
          onClick={() => void save('DRAFT')}
        >
          保存草稿
        </button>
        <button
          type="button"
          className="primary small"
          disabled={busy}
          onClick={() => void save('PUBLISHED')}
        >
          发布到玩家端
        </button>
      </footer>
      <Notice message={message} />
    </section>
  );
}

export function GameRulesAndConfig({ gameCode }: { gameCode: string }) {
  return (
    <div className="game-rules-config-stack">
      <GameConfigEditor gameCode={gameCode} />
      <RuleDocumentEditor gameCode={gameCode} />
    </div>
  );
}

type RewardDraft = {
  tab: 'CHESS' | 'BANKER' | 'SPECIAL';
  code: string;
  title: string;
  amountRm: string;
  dailyQuota: string;
  status: 'ACTIVE' | 'DISABLED';
  conditions: RewardConditionDraft;
};

const emptyReward: RewardDraft = {
  tab: 'SPECIAL',
  code: 'special_',
  title: '',
  amountRm: '',
  dailyQuota: '0',
  status: 'ACTIVE',
  conditions: emptyConditionDraft('manual'),
};

export function GameRewardsAdmin({ gameCode }: { gameCode: string }) {
  const [items, setItems] = useState<Row[]>([]);
  const [grants, setGrants] = useState<Row[]>([]);
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState<RewardDraft>(emptyReward);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/admin/games/${encodeURIComponent(gameCode)}/rewards`;

  async function load() {
    const [configs, history] = await Promise.all([
      request<{ items: Row[] }>(base),
      request<{ items: Row[] }>(`${base}/grants`),
    ]);
    setItems(configs.items);
    setGrants(history.items);
  }

  useEffect(() => {
    void load().catch((error) => setMessage((error as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameCode]);

  function edit(item?: Row) {
    setEditingId(item?.id ?? '');
    setDraft(
      item
        ? {
            tab: item.tab,
            code: item.code,
            title: item.title,
            amountRm: rm(item.amountCents),
            dailyQuota: String(item.dailyQuota),
            status: item.status,
            conditions: parseConditionDraft(item.conditions),
          }
        : {
            ...emptyReward,
            conditions: emptyConditionDraft('manual'),
          },
    );
  }

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      await post(base, {
        tab: draft.tab,
        code: draft.code.trim(),
        title: draft.title.trim(),
        amountCents: toCents(draft.amountRm),
        dailyQuota: Number(draft.dailyQuota),
        status: draft.status,
        conditions: serializeConditionDraft(draft.conditions),
      });
      await load();
      setEditingId('');
      setDraft({ ...emptyReward, conditions: emptyConditionDraft('manual') });
      setMessage('奖励规则已保存，仅影响当前游戏。');
    } catch (error) {
      setMessage(`保存失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function manualGrant(item: Row) {
    const uid = window.prompt(`补发「${item.title}」：请输入玩家 UID`);
    if (!uid) return;
    const date = window.prompt('业务日（YYYY-MM-DD，留空为今天）') || undefined;
    try {
      const result = await post<{ granted: boolean }>(
        `${base}/${item.id}/grant`,
        { uid: uid.trim(), date },
      );
      setMessage(
        result.granted
          ? '补发成功，奖励已入账。'
          : '未发放：玩家当日已领取或配额已满。',
      );
      await load();
    } catch (error) {
      setMessage(`补发失败：${(error as Error).message}`);
    }
  }

  return (
    <div className="game-rewards-page">
      <section className="panel reward-editor-panel">
        <div className="panel-title">
          <div>
            <small>每日奖励 · {gameCode}</small>
            <h2>{editingId ? '编辑奖励规则' : '新建奖励规则'}</h2>
          </div>
          {editingId && (
            <button type="button" onClick={() => edit()}>取消编辑</button>
          )}
        </div>
        <div className="reward-editor-grid">
          <label>
            分类
            <select
              value={draft.tab}
              onChange={(event) =>
                setDraft({ ...draft, tab: event.target.value as RewardDraft['tab'] })
              }
            >
              <option value="CHESS">棋牌</option>
              <option value="BANKER">庄家</option>
              <option value="SPECIAL">特别</option>
            </select>
          </label>
          <label>
            规则代码
            <input value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} />
          </label>
          <label>
            展示名称
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </label>
          <label>
            奖励金额（RM）
            <input value={draft.amountRm} onChange={(event) => setDraft({ ...draft, amountRm: event.target.value })} />
          </label>
          <label>
            每日份数（0 = 不限）
            <input type="number" min="0" value={draft.dailyQuota} onChange={(event) => setDraft({ ...draft, dailyQuota: event.target.value })} />
          </label>
          <label>
            状态
            <select
              value={draft.status}
              onChange={(event) =>
                setDraft({ ...draft, status: event.target.value as RewardDraft['status'] })
              }
            >
              <option value="ACTIVE">启用</option>
              <option value="DISABLED">停用</option>
            </select>
          </label>
          <div className="wide">
            <strong className="reward-condition-title">达成条件</strong>
            <RewardConditionsForm
              value={draft.conditions}
              onChange={(conditions) => setDraft({ ...draft, conditions })}
            />
          </div>
        </div>
        <button
          type="button"
          className="primary small"
          disabled={busy || !draft.code.trim() || !draft.title.trim() || !draft.amountRm.trim()}
          onClick={() => void save()}
        >
          {busy ? '保存中…' : '保存奖励规则'}
        </button>
        <Notice message={message} />
      </section>

      <div className="reward-config-grid">
        {items.map((item) => (
          <article key={item.id}>
            <header>
              <span className={`scope-pill ${item.status.toLowerCase()}`}>{item.status === 'ACTIVE' ? '启用' : '停用'}</span>
              <span>{item.tab}</span>
            </header>
            <h3>{item.title}</h3>
            <strong>RM {rm(item.amountCents)}</strong>
            <p className="reward-condition-summary">{summarizeConditions(item.conditions)}</p>
            <footer>
              <span>每日 {item.dailyQuota === 0 ? '不限量' : `${item.dailyQuota} 份`}</span>
              <button type="button" onClick={() => void manualGrant(item)}>补发</button>
              <button type="button" onClick={() => edit(item)}>编辑</button>
            </footer>
          </article>
        ))}
      </div>

      <section className="panel">
        <div className="panel-title">
          <div><small>当前游戏</small><h2>奖励发放记录</h2></div>
          <span>最近 {grants.length} 条</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>奖励</th><th>玩家</th><th>金额</th><th>业务日</th></tr></thead>
            <tbody>
              {grants.map((grant) => (
                <tr key={grant.id}>
                  <td>{new Date(grant.grantedAt).toLocaleString('zh-MY')}</td>
                  <td>{grant.config?.title}</td>
                  <td>{grant.user?.nickname ?? grant.user?.uid}</td>
                  <td className="money">RM {rm(grant.amountCents)}</td>
                  <td>{grant.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!grants.length && <div className="game-scope-empty">当前游戏暂无奖励发放记录</div>}
        </div>
      </section>
    </div>
  );
}

type PrizeRow = { rank: string; amountRm: string };

const defaultPrizes: PrizeRow[] = [
  { rank: '1', amountRm: '88.88' },
  { rank: '2', amountRm: '38.88' },
  { rank: '3', amountRm: '18.88' },
];

export function GameLeaderboardsAdmin({ gameCode }: { gameCode: string }) {
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [data, setData] = useState<Row | null>(null);
  const [message, setMessage] = useState('');
  const [rewardType, setRewardType] = useState('');
  const [prizes, setPrizes] = useState<PrizeRow[]>(defaultPrizes);
  const [busy, setBusy] = useState(false);
  const base = `/api/admin/games/${encodeURIComponent(gameCode)}/leaderboards`;

  async function load() {
    setData(await request<Row>(`${base}?period=${period}`));
  }

  useEffect(() => {
    void load().catch((error) => setMessage((error as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameCode, period]);

  const enabledTypes = useMemo(
    () => (data?.enabledTypes ?? ['points', 'hands', 'banker']) as string[],
    [data],
  );

  const rewardLabel =
    data?.labels?.[rewardType] ??
    ({ points: '积分榜', hands: '牌型榜', banker: '打桩榜' } as Record<string, string>)[
      rewardType
    ] ??
    rewardType;

  async function submitPrizes() {
    setBusy(true);
    setMessage('');
    try {
      const parsed = prizes
        .map((item) => ({
          rank: Number(item.rank),
          amountCents: toCents(item.amountRm || '0'),
        }))
        .filter(
          (prize) =>
            Number.isInteger(prize.rank) &&
            prize.rank > 0 &&
            BigInt(prize.amountCents) > 0n,
        );
      if (!parsed.length) {
        setMessage('请至少填写一个有效名次与奖金。');
        return;
      }
      if (
        !window.confirm(
          `确认按当前 ${period}「${rewardLabel}」快照发放 ${parsed.length} 个名次？`,
        )
      ) {
        return;
      }
      const result = await post<{ results: Row[] }>(`${base}/reward`, {
        type: rewardType,
        period,
        prizes: parsed,
      });
      const granted = result.results.filter((row) => row.granted).length;
      setMessage(`发放完成：成功 ${granted} 人，跳过 ${result.results.length - granted} 人。`);
      setRewardType('');
    } catch (error) {
      setMessage(`发放失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="game-leaderboards-page">
      <div className="toolbar standalone">
        <div className="toolbar-hint">
          <small>排行榜 · {gameCode}</small>
          <span>积分榜固定按本游戏已结算有效流水统计</span>
        </div>
        <select value={period} onChange={(event) => setPeriod(event.target.value as typeof period)}>
          <option value="daily">日榜</option>
          <option value="weekly">周榜</option>
          <option value="monthly">月榜</option>
        </select>
        <button
          type="button"
          className="primary small"
          onClick={async () => {
            await post(`${base}/generate`, {});
            await load();
            setMessage('当前游戏榜单快照已重新生成。');
          }}
        >
          立即生成快照
        </button>
      </div>
      <Notice message={message} />

      {rewardType && (
        <section className="panel leaderboard-prize-panel">
          <div className="panel-title">
            <div>
              <small>发放奖金</small>
              <h2>{rewardLabel} · {period}</h2>
            </div>
            <button type="button" onClick={() => setRewardType('')}>取消</button>
          </div>
          <p className="cfg-help">按名次填写奖金（RM）。留空或 0 的行会忽略。</p>
          <div className="leaderboard-prize-grid">
            {prizes.map((item, index) => (
              <div className="leaderboard-prize-row" key={index}>
                <label>
                  名次
                  <input
                    type="number"
                    min={1}
                    value={item.rank}
                    onChange={(event) =>
                      setPrizes((current) =>
                        current.map((row, i) =>
                          i === index ? { ...row, rank: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  奖金（RM）
                  <input
                    value={item.amountRm}
                    onChange={(event) =>
                      setPrizes((current) =>
                        current.map((row, i) =>
                          i === index ? { ...row, amountRm: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="small"
                  disabled={prizes.length <= 1}
                  onClick={() =>
                    setPrizes((current) => current.filter((_, i) => i !== index))
                  }
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <div className="leaderboard-prize-actions">
            <button
              type="button"
              className="small"
              onClick={() =>
                setPrizes((current) => [
                  ...current,
                  { rank: String(current.length + 1), amountRm: '' },
                ])
              }
            >
              + 增加名次
            </button>
            <button
              type="button"
              className="primary small"
              disabled={busy}
              onClick={() => void submitPrizes()}
            >
              {busy ? '发放中…' : '确认发放'}
            </button>
          </div>
        </section>
      )}

      <div className="board-admin-grid">
        {enabledTypes.map((type) => {
          const label = data?.labels?.[type] ?? {
            points: '积分榜',
            hands: '牌型榜',
            banker: '打桩榜',
          }[type] ?? type;
          const ranks = data?.boards?.[type]?.ranks ?? [];
          return (
            <section className="panel" key={type}>
              <div className="panel-title">
                <div><small>{period}</small><h2>{label}</h2></div>
                <button
                  type="button"
                  onClick={() => {
                    setRewardType(type);
                    setPrizes(defaultPrizes);
                    setMessage('');
                  }}
                >
                  发放奖励
                </button>
              </div>
              {ranks.slice(0, 20).map((rank: Row) => (
                <div className="mini-rank" key={rank.rank}>
                  <b>{rank.rank}</b>
                  <span>{rank.nickname}<small>{rank.uid}</small></span>
                  <strong>{type === 'points' ? `RM ${rm(rank.score)}` : rank.score}</strong>
                </div>
              ))}
              {!ranks.length && <div className="game-scope-empty">该周期暂无上榜数据</div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

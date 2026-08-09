export type RewardConditionKind =
  | 'manual'
  | 'hand_count'
  | 'hand_combo'
  | 'banker_rounds'
  | 'banker_instant';

export type RewardConditionDraft = {
  kind: RewardConditionKind;
  handType: string;
  count: string;
  /** banker_instant 门槛金额，RM */
  amountRm: string;
  /** hand_combo：各牌型至少次数 */
  combo: Record<string, string>;
};

const HAND_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'BAOZI', label: '豹子' },
  { key: 'MANNIU', label: '满牛' },
  { key: 'FANSHUN', label: '反顺' },
  { key: 'SHUNZI', label: '顺子' },
  { key: 'DUIZI', label: '对子' },
  { key: 'JINNIU', label: '金牛' },
];

const HAND_LABEL: Record<string, string> = Object.fromEntries(
  HAND_OPTIONS.map((item) => [item.key, item.label]),
);

const KIND_LABEL: Record<RewardConditionKind, string> = {
  manual: '仅手动补发',
  hand_count: '累计某牌型次数',
  hand_combo: '组合牌型齐全',
  banker_rounds: '做庄局数',
  banker_instant: '庄家秒杀次数',
};

function centsToRm(cents: unknown): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '0.01';
  return (n / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function rmToCents(value: string): number {
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`金额格式无效：${value || '(空)'}`);
  }
  const [integer, decimal = ''] = cleaned.split('.');
  return Number(
    BigInt(integer || '0') * 100n + BigInt((decimal + '00').slice(0, 2)),
  );
}

export function emptyConditionDraft(
  kind: RewardConditionKind = 'manual',
): RewardConditionDraft {
  return {
    kind,
    handType: 'BAOZI',
    count: '3',
    amountRm: '0.01',
    combo: {
      BAOZI: '1',
      SHUNZI: '1',
      FANSHUN: '1',
      MANNIU: '1',
    },
  };
}

export function parseConditionDraft(raw: unknown): RewardConditionDraft {
  const base = emptyConditionDraft();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const condition = raw as Record<string, unknown>;
  const kind = (condition.kind as RewardConditionKind) || 'manual';
  if (!KIND_LABEL[kind]) return emptyConditionDraft('manual');

  if (kind === 'hand_count') {
    return {
      ...base,
      kind,
      handType: String(condition.handType ?? 'BAOZI'),
      count: String(condition.count ?? 1),
    };
  }
  if (kind === 'hand_combo') {
    const required =
      condition.required && typeof condition.required === 'object' && !Array.isArray(condition.required)
        ? (condition.required as Record<string, unknown>)
        : {};
    const combo: Record<string, string> = {};
    for (const item of HAND_OPTIONS) {
      combo[item.key] = String(required[item.key] ?? 0);
    }
    return { ...base, kind, combo };
  }
  if (kind === 'banker_rounds') {
    return { ...base, kind, count: String(condition.count ?? 1) };
  }
  if (kind === 'banker_instant') {
    return {
      ...base,
      kind,
      count: String(condition.count ?? 3),
      amountRm: centsToRm(condition.amountCents ?? 1),
    };
  }
  return emptyConditionDraft('manual');
}

export function serializeConditionDraft(draft: RewardConditionDraft): Record<string, unknown> {
  if (draft.kind === 'manual') return { kind: 'manual' };
  if (draft.kind === 'hand_count') {
    const count = Number(draft.count);
    if (!Number.isInteger(count) || count < 1) throw new Error('牌型次数须为 ≥1 的整数');
    if (!HAND_LABEL[draft.handType]) throw new Error('请选择牌型');
    return { kind: 'hand_count', handType: draft.handType, count };
  }
  if (draft.kind === 'hand_combo') {
    const required: Record<string, number> = {};
    for (const [hand, value] of Object.entries(draft.combo)) {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`${HAND_LABEL[hand] ?? hand}次数无效`);
      }
      if (count > 0) required[hand] = count;
    }
    if (!Object.keys(required).length) {
      throw new Error('组合条件至少填写一种牌型次数');
    }
    return { kind: 'hand_combo', required };
  }
  if (draft.kind === 'banker_rounds') {
    const count = Number(draft.count);
    if (!Number.isInteger(count) || count < 1) throw new Error('做庄局数须为 ≥1 的整数');
    return { kind: 'banker_rounds', count };
  }
  if (draft.kind === 'banker_instant') {
    const count = Number(draft.count);
    if (!Number.isInteger(count) || count < 1) throw new Error('秒杀次数须为 ≥1 的整数');
    return {
      kind: 'banker_instant',
      count,
      amountCents: rmToCents(draft.amountRm),
    };
  }
  return { kind: 'manual' };
}

export function summarizeConditions(raw: unknown): string {
  const draft = parseConditionDraft(raw);
  if (draft.kind === 'manual') return '仅支持后台手动补发';
  if (draft.kind === 'hand_count') {
    return `当日累计「${HAND_LABEL[draft.handType] ?? draft.handType}」≥ ${draft.count} 次`;
  }
  if (draft.kind === 'hand_combo') {
    const parts = Object.entries(draft.combo)
      .filter(([, count]) => Number(count) > 0)
      .map(([hand, count]) => `${HAND_LABEL[hand] ?? hand}×${count}`);
    return parts.length ? `组合达成：${parts.join('、')}` : '组合条件未配置';
  }
  if (draft.kind === 'banker_rounds') {
    return `当日做庄 ≥ ${draft.count} 局`;
  }
  if (draft.kind === 'banker_instant') {
    return `庄家秒杀 ≥ ${draft.count} 次（门槛 RM ${draft.amountRm}）`;
  }
  return '未知条件';
}

export default function RewardConditionsForm({
  value,
  onChange,
}: {
  value: RewardConditionDraft;
  onChange: (next: RewardConditionDraft) => void;
}) {
  return (
    <div className="reward-condition-form">
      <label>
        达成条件类型
        <select
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value as RewardConditionKind;
            onChange({ ...emptyConditionDraft(kind), kind });
          }}
        >
          {Object.entries(KIND_LABEL).map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {value.kind === 'manual' && (
        <p className="cfg-help">不会自动发放，只能在列表里点「补发」。</p>
      )}

      {value.kind === 'hand_count' && (
        <>
          <label>
            牌型
            <select
              value={value.handType}
              onChange={(event) =>
                onChange({ ...value, handType: event.target.value })
              }
            >
              {HAND_OPTIONS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            需要次数
            <input
              type="number"
              min={1}
              value={value.count}
              onChange={(event) =>
                onChange({ ...value, count: event.target.value })
              }
            />
          </label>
        </>
      )}

      {value.kind === 'hand_combo' && (
        <div className="reward-combo-grid">
          <p className="cfg-help">填写各牌型至少需要的次数；填 0 表示不要求该牌型。</p>
          {HAND_OPTIONS.map((item) => (
            <label key={item.key}>
              {item.label}
              <input
                type="number"
                min={0}
                value={value.combo[item.key] ?? '0'}
                onChange={(event) =>
                  onChange({
                    ...value,
                    combo: { ...value.combo, [item.key]: event.target.value },
                  })
                }
              />
            </label>
          ))}
        </div>
      )}

      {value.kind === 'banker_rounds' && (
        <label>
          做庄局数
          <input
            type="number"
            min={1}
            value={value.count}
            onChange={(event) =>
              onChange({ ...value, count: event.target.value })
            }
          />
        </label>
      )}

      {value.kind === 'banker_instant' && (
        <>
          <label>
            秒杀次数
            <input
              type="number"
              min={1}
              value={value.count}
              onChange={(event) =>
                onChange({ ...value, count: event.target.value })
              }
            />
          </label>
          <label>
            单次门槛金额（RM）
            <input
              value={value.amountRm}
              onChange={(event) =>
                onChange({ ...value, amountRm: event.target.value })
              }
            />
          </label>
        </>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { put, request } from './api';

type Row = Record<string, any>;

const configMeta: Record<string, { label: string; hint: string }> = {
  hand: { label: '牌型规则', hint: '牌型倍数、爆点门槛与特殊牌型' },
  betting: { label: '下注规则', hint: '普通下注、梭哈与人数系数' },
  fees: { label: '费用规则', hint: '庄位费、服务费、红包费与抽水' },
  round: { label: '牌局流程', hint: '阶段时长、竞标范围与自动化开关' },
  rebate: { label: '返水口径', hint: '本游戏有效流水与三级返水比例' },
  rewards: { label: '奖励门槛', hint: '牌型奖励所需的最低下注条件' },
  leaderboard: { label: '排行榜', hint: '榜型、Top N、显示名称与积分口径' },
  messages: { label: '小助手话术', hint: '当前游戏独立使用的阶段消息模板' },
};

const HAND_TYPES: Array<{ key: string; label: string }> = [
  { key: 'BAOZI', label: '豹子' },
  { key: 'MANNIU', label: '满牛' },
  { key: 'FANSHUN', label: '反顺' },
  { key: 'SHUNZI', label: '顺子' },
  { key: 'DUIZI', label: '对子' },
  { key: 'JINNIU', label: '金牛' },
  { key: 'NORMAL', label: '普通（占位，实际用下方点数倍数）' },
];

const NORMAL_POINTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

const MESSAGE_FIELDS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'welcome', label: '进群欢迎语' },
  { key: 'bidStart', label: '竞标开始' },
  { key: 'bidPlaced', label: '有人出价' },
  { key: 'bidCountdownStart', label: '竞标倒计时开始' },
  { key: 'bidCountdown3', label: '倒计时 3' },
  { key: 'bidCountdown2', label: '倒计时 2' },
  { key: 'bidCountdown1', label: '倒计时 1' },
  { key: 'bidFinalList', label: '竞标最终名单' },
  { key: 'bidClosing', label: '竞标截止（旧模板，兼容保留）' },
  { key: 'bankerSelected', label: '庄家锁定' },
  { key: 'betStart', label: '开注' },
  { key: 'betCountdown', label: '下注倒计时' },
  { key: 'sealed', label: '封盘提示' },
  { key: 'sealedSummary', label: '封盘明细' },
  { key: 'dicePrompt', label: '庄家投骰提示' },
  { key: 'bankerDice', label: '庄家开骰结果' },
  { key: 'claimStart', label: '开始抢包' },
  { key: 'claimWarning', label: '领包提醒' },
  { key: 'claimCountdown', label: '抢包倒计时' },
  { key: 'claimExpiredEdit', label: '抢包结束（编辑中）' },
  { key: 'claimExpired', label: '抢包结束' },
  { key: 'rakeNotice', label: '抽水通告' },
  { key: 'settlingWait', label: '结算中' },
  { key: 'cancelled', label: '本局取消' },
  { key: 'continuationPrompt', label: '续庄询问' },
  { key: 'rewardCongrats', label: '奖励到账' },
];

function Notice({ message }: { message: string }) {
  if (!message) return null;
  return <div className="game-scope-notice" role="status">{message}</div>;
}

function centsToRm(cents: unknown): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '';
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

function ratioToPercent(ratio: unknown): string {
  const n = Number(ratio);
  if (!Number.isFinite(n)) return '';
  return String(Number((n * 100).toFixed(4)));
}

function percentToRatio(value: string): number {
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0) throw new Error(`百分比无效：${value || '(空)'}`);
  return Number((n / 100).toFixed(6));
}

function intOrThrow(value: string, label: string): number {
  const n = Number(value.trim());
  if (!Number.isInteger(n)) throw new Error(`${label}须为整数`);
  return n;
}

function numOrThrow(value: string, label: string): number {
  const n = Number(value.trim());
  if (!Number.isFinite(n)) throw new Error(`${label}须为数字`);
  return n;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="cfg-field">
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="cfg-section">
      <h3>{title}</h3>
      <div className="cfg-grid">{children}</div>
    </div>
  );
}

function HandForm({
  value,
  onChange,
}: {
  value: Row;
  onChange: (next: Row) => void;
}) {
  const multipliers = value.multipliers ?? {};
  const normal = value.normalMultipliers ?? {};
  return (
    <>
      <Section title="特殊牌型倍数（0.01免死；全表最高倍数=赔付预留倍数，默认17倍）">
        {HAND_TYPES.map((item) => (
          <Field key={item.key} label={item.label} hint="倍">
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={multipliers[item.key] ?? ''}
              onChange={(event) =>
                onChange({
                  ...value,
                  multipliers: {
                    ...multipliers,
                    [item.key]: Number(event.target.value),
                  },
                })
              }
            />
          </Field>
        ))}
      </Section>
      <Section title="普通牌型点数倍数（1–10 点，10=牛牛）">
        {NORMAL_POINTS.map((point) => (
          <Field
            key={point}
            label={point === 10 ? '牛牛（10点）' : `${point} 点`}
            hint="倍"
          >
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={normal[point] ?? normal[String(point)] ?? ''}
              onChange={(event) =>
                onChange({
                  ...value,
                  normalMultipliers: {
                    ...normal,
                    [point]: Number(event.target.value),
                  },
                })
              }
            />
          </Field>
        ))}
      </Section>
      <Section title="自爆规则">
        <Field label="自爆门槛" hint="点数 ≤ 此值判自爆（0–10）">
          <input
            type="number"
            min={0}
            max={10}
            step={1}
            value={value.bustThreshold ?? ''}
            onChange={(event) =>
              onChange({ ...value, bustThreshold: Number(event.target.value) })
            }
          />
        </Field>
        <Field label="特殊牌型豁免自爆" hint="开启后豹子等特殊牌型不自爆">
          <select
            value={value.bustExemptSpecialHands === false ? '0' : '1'}
            onChange={(event) =>
              onChange({
                ...value,
                bustExemptSpecialHands: event.target.value === '1',
              })
            }
          >
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </Field>
      </Section>
    </>
  );
}

function BettingForm({
  value,
  onChange,
}: {
  value: Row;
  onChange: (next: Row) => void;
}) {
  const tiers: Array<{ maxPlayers: number; coef: number }> = Array.isArray(
    value.playerCoefTiers,
  )
    ? value.playerCoefTiers
    : [];

  return (
    <>
      <Section title="下注金额下限">
        <Field label="普通下注最低" hint="RM">
          <input
            value={centsToRm(value.betMinCents)}
            onChange={(event) =>
              onChange({ ...value, betMinCents: event.target.value })
            }
          />
        </Field>
        <Field label="梭哈最低" hint="RM">
          <input
            value={centsToRm(value.shMinCents)}
            onChange={(event) =>
              onChange({ ...value, shMinCents: event.target.value })
            }
          />
        </Field>
      </Section>
      <Section title="上限比例（相对庄钱）">
        <Field label="普通下注比例" hint="% ，例如 0.5 表示庄钱的 0.5%">
          <input
            value={ratioToPercent(value.betRatio)}
            onChange={(event) =>
              onChange({ ...value, betRatio: event.target.value })
            }
          />
        </Field>
        <Field label="梭哈比例" hint="% ，例如 5 表示庄钱的 5%">
          <input
            value={ratioToPercent(value.shRatio)}
            onChange={(event) =>
              onChange({ ...value, shRatio: event.target.value })
            }
          />
        </Field>
      </Section>
      <Section title="人数系数分档">
        <p className="cfg-help">
          按「人数上限」从小到大匹配：实际人数 ≤ 上限时使用该系数。上限越大越靠后。
        </p>
        {tiers.map((tier, index) => (
          <div className="cfg-tier-row" key={index}>
            <Field label="人数上限">
              <input
                type="number"
                min={1}
                value={tier.maxPlayers}
                onChange={(event) => {
                  const next = tiers.map((item, i) =>
                    i === index
                      ? { ...item, maxPlayers: Number(event.target.value) }
                      : item,
                  );
                  onChange({ ...value, playerCoefTiers: next });
                }}
              />
            </Field>
            <Field label="系数">
              <input
                type="number"
                min={0.01}
                step={0.1}
                value={tier.coef}
                onChange={(event) => {
                  const next = tiers.map((item, i) =>
                    i === index
                      ? { ...item, coef: Number(event.target.value) }
                      : item,
                  );
                  onChange({ ...value, playerCoefTiers: next });
                }}
              />
            </Field>
            <button
              type="button"
              className="small"
              disabled={tiers.length <= 1}
              onClick={() =>
                onChange({
                  ...value,
                  playerCoefTiers: tiers.filter((_, i) => i !== index),
                })
              }
            >
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="small"
          onClick={() =>
            onChange({
              ...value,
              playerCoefTiers: [...tiers, { maxPlayers: 99, coef: 1 }],
            })
          }
        >
          + 增加分档
        </button>
      </Section>
    </>
  );
}

function FeesForm({
  value,
  onChange,
}: {
  value: Row;
  onChange: (next: Row) => void;
}) {
  return (
    <Section title="费用与抽水">
      <Field label="上庄费比例" hint="% ，相对庄钱，例如 1 = 1%">
        <input
          value={ratioToPercent(value.bankerSeatFeeRatio)}
          onChange={(event) =>
            onChange({ ...value, bankerSeatFeeRatio: event.target.value })
          }
        />
      </Field>
      <Field label="服务费（每场固定）" hint="RM">
        <input
          value={centsToRm(value.serviceFeeCents)}
          onChange={(event) =>
            onChange({ ...value, serviceFeeCents: event.target.value })
          }
        />
      </Field>
      <Field label="红包人均单价" hint="RM / 人">
        <input
          value={centsToRm(value.packetPerHeadCents)}
          onChange={(event) =>
            onChange({ ...value, packetPerHeadCents: event.target.value })
          }
        />
      </Field>
      <Field label="玩家赢抽水比例" hint="% ，只抽闲家赢方盈利，例如 3 = 3%">
        <input
          value={ratioToPercent(value.playerRakeRatio)}
          onChange={(event) =>
            onChange({ ...value, playerRakeRatio: event.target.value })
          }
        />
      </Field>
      <Field label="庄家赢抽水比例" hint="% ，只抽庄家赢方盈利，例如 5 = 5%">
        <input
          value={ratioToPercent(value.bankerRakeRatio)}
          onChange={(event) =>
            onChange({ ...value, bankerRakeRatio: event.target.value })
          }
        />
      </Field>
    </Section>
  );
}

function RoundForm({
  value,
  onChange,
}: {
  value: Row;
  onChange: (next: Row) => void;
}) {
  return (
    <>
      <Section title="阶段时长（秒）">
        <Field label="竞标时长">
          <input
            type="number"
            min={5}
            value={value.bidDurationSeconds ?? ''}
            onChange={(event) =>
              onChange({ ...value, bidDurationSeconds: Number(event.target.value) })
            }
          />
        </Field>
        <Field label="下注时长">
          <input
            type="number"
            min={5}
            value={value.betDurationSeconds ?? ''}
            onChange={(event) =>
              onChange({ ...value, betDurationSeconds: Number(event.target.value) })
            }
          />
        </Field>
        <Field label="抢包时长">
          <input
            type="number"
            min={5}
            value={value.claimDurationSeconds ?? ''}
            onChange={(event) =>
              onChange({
                ...value,
                claimDurationSeconds: Number(event.target.value),
              })
            }
          />
        </Field>
        <Field label="续庄确认窗口">
          <input
            type="number"
            min={5}
            value={value.continuationWindowSeconds ?? ''}
            onChange={(event) =>
              onChange({
                ...value,
                continuationWindowSeconds: Number(event.target.value),
              })
            }
          />
        </Field>
      </Section>
      <Section title="竞标金额范围">
        <Field label="最低出价" hint="RM">
          <input
            value={centsToRm(value.bankerBidMinCents)}
            onChange={(event) =>
              onChange({ ...value, bankerBidMinCents: event.target.value })
            }
          />
        </Field>
        <Field label="最高出价" hint="RM">
          <input
            value={centsToRm(value.bankerBidMaxCents)}
            onChange={(event) =>
              onChange({ ...value, bankerBidMaxCents: event.target.value })
            }
          />
        </Field>
        <Field label="走势条长度" hint="显示最近多少局">
          <input
            type="number"
            min={1}
            max={100}
            value={value.trendLength ?? ''}
            onChange={(event) =>
              onChange({ ...value, trendLength: Number(event.target.value) })
            }
          />
        </Field>
      </Section>
      <Section title="发包方式">
        <Field
          label="红包渠道"
          hint="TNG=运营粘贴链接、玩家跳转外部抢包；内部红包=投骰后小助手自动发包，玩家群内直抢并即时入余额"
        >
          <select
            value={value.packetChannel === 'INTERNAL' ? 'INTERNAL' : 'TNG'}
            onChange={(event) =>
              onChange({ ...value, packetChannel: event.target.value })
            }
          >
            <option value="TNG">TNG 链接</option>
            <option value="INTERNAL">内部红包（小助手直发）</option>
          </select>
        </Field>
      </Section>
      <Section title="自动化开关">
        <Field label="小助手服务" hint="关闭后不再自动播报，也不自动开局">
          <select
            value={value.assistantEnabled === false ? '0' : '1'}
            onChange={(event) =>
              onChange({
                ...value,
                assistantEnabled: event.target.value === '1',
                ...(event.target.value === '0' ? { autoStart: false } : {}),
              })
            }
          >
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </Field>
        <Field label="自动开局" hint="需先开启小助手">
          <select
            value={value.autoStart ? '1' : '0'}
            disabled={value.assistantEnabled === false}
            onChange={(event) =>
              onChange({ ...value, autoStart: event.target.value === '1' })
            }
          >
            <option value="0">关闭</option>
            <option value="1">开启</option>
          </select>
        </Field>
        <Field label="自动认尾包">
          <select
            value={value.autoTailPacketEnabled ? '1' : '0'}
            onChange={(event) =>
              onChange({
                ...value,
                autoTailPacketEnabled: event.target.value === '1',
              })
            }
          >
            <option value="0">关闭</option>
            <option value="1">开启</option>
          </select>
        </Field>
        <Field label="自动发包">
          <select
            value={value.autoPublishPacketEnabled ? '1' : '0'}
            onChange={(event) =>
              onChange({
                ...value,
                autoPublishPacketEnabled: event.target.value === '1',
              })
            }
          >
            <option value="0">关闭</option>
            <option value="1">开启</option>
          </select>
        </Field>
      </Section>
      <Section title="代包手展示名">
        <Field label="庄家尾包代包手">
          <input
            value={value.tailPackerBankerName ?? ''}
            maxLength={80}
            onChange={(event) =>
              onChange({ ...value, tailPackerBankerName: event.target.value })
            }
          />
        </Field>
        <Field label="闲家尾包代包手">
          <input
            value={value.tailPackerPlayerName ?? ''}
            maxLength={80}
            onChange={(event) =>
              onChange({ ...value, tailPackerPlayerName: event.target.value })
            }
          />
        </Field>
      </Section>
    </>
  );
}

function RebateForm({
  value,
  onChange,
}: {
  value: Row;
  onChange: (next: Row) => void;
}) {
  return (
    <Section title="三级返水比例">
      <Field label="自身返水" hint="% ，例如 0.7">
        <input
          value={ratioToPercent(value.selfRate)}
          onChange={(event) =>
            onChange({ ...value, selfRate: event.target.value })
          }
        />
      </Field>
      <Field label="一级（直属）返水" hint="%">
        <input
          value={ratioToPercent(value.l1Rate)}
          onChange={(event) =>
            onChange({ ...value, l1Rate: event.target.value })
          }
        />
      </Field>
      <Field label="二级返水" hint="%">
        <input
          value={ratioToPercent(value.l2Rate)}
          onChange={(event) =>
            onChange({ ...value, l2Rate: event.target.value })
          }
        />
      </Field>
      <Field label="平局是否计入有效流水">
        <select
          value={value.includeTieBets ? '1' : '0'}
          onChange={(event) =>
            onChange({ ...value, includeTieBets: event.target.value === '1' })
          }
        >
          <option value="0">不计</option>
          <option value="1">计入</option>
        </select>
      </Field>
    </Section>
  );
}

function RewardsForm({
  value,
  onChange,
}: {
  value: Row;
  onChange: (next: Row) => void;
}) {
  return (
    <Section title="领取奖励的最低门槛">
      <Field label="普通下注最低" hint="RM">
        <input
          value={centsToRm(value.minBetCents)}
          onChange={(event) =>
            onChange({ ...value, minBetCents: event.target.value })
          }
        />
      </Field>
      <Field label="梭哈最低" hint="RM">
        <input
          value={centsToRm(value.minAllInCents)}
          onChange={(event) =>
            onChange({ ...value, minAllInCents: event.target.value })
          }
        />
      </Field>
      <Field label="庄家即时奖励金额" hint="RM">
        <input
          value={centsToRm(value.bankerInstantAmountCents)}
          onChange={(event) =>
            onChange({ ...value, bankerInstantAmountCents: event.target.value })
          }
        />
      </Field>
    </Section>
  );
}

function LeaderboardForm({
  value,
  onChange,
}: {
  value: Row;
  onChange: (next: Row) => void;
}) {
  const enabled: string[] = Array.isArray(value.enabledTypes)
    ? value.enabledTypes
    : ['points', 'hands', 'banker'];
  const labels = value.labels ?? {};

  function toggleType(type: string) {
    const next = enabled.includes(type)
      ? enabled.filter((item) => item !== type)
      : [...enabled, type];
    onChange({ ...value, enabledTypes: next });
  }

  return (
    <>
      <Section title="榜单参数">
        <Field label="展示 Top N">
          <input
            type="number"
            min={1}
            max={500}
            value={value.topN ?? ''}
            onChange={(event) =>
              onChange({ ...value, topN: Number(event.target.value) })
            }
          />
        </Field>
        <Field label="昵称脱敏">
          <select
            value={value.maskNames === false ? '0' : '1'}
            onChange={(event) =>
              onChange({ ...value, maskNames: event.target.value === '1' })
            }
          >
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </Field>
        <Field label="积分口径" hint="当前仅支持流水 turnover">
          <input value="turnover（有效流水）" disabled />
        </Field>
      </Section>
      <Section title="启用的榜单类型">
        {(
          [
            ['points', '积分榜'],
            ['hands', '牌型榜'],
            ['banker', '打桩榜'],
          ] as const
        ).map(([type, label]) => (
          <label key={type} className="cfg-check">
            <input
              type="checkbox"
              checked={enabled.includes(type)}
              onChange={() => toggleType(type)}
            />
            <span>{label}</span>
          </label>
        ))}
      </Section>
      <Section title="榜单显示名称">
        <Field label="积分榜名称">
          <input
            value={labels.points ?? ''}
            maxLength={30}
            onChange={(event) =>
              onChange({
                ...value,
                labels: { ...labels, points: event.target.value },
              })
            }
          />
        </Field>
        <Field label="牌型榜名称">
          <input
            value={labels.hands ?? ''}
            maxLength={30}
            onChange={(event) =>
              onChange({
                ...value,
                labels: { ...labels, hands: event.target.value },
              })
            }
          />
        </Field>
        <Field label="打桩榜名称">
          <input
            value={labels.banker ?? ''}
            maxLength={30}
            onChange={(event) =>
              onChange({
                ...value,
                labels: { ...labels, banker: event.target.value },
              })
            }
          />
        </Field>
      </Section>
    </>
  );
}

function MessagesForm({
  value,
  onChange,
}: {
  value: Row;
  onChange: (next: Row) => void;
}) {
  return (
    <Section title="阶段话术（可用 {{变量}} 占位）">
      <p className="cfg-help">
        常见变量：{'{{seqNo}}'} {'{{banker}}'} {'{{pot}}'} {'{{player}}'}{' '}
        {'{{amount}}'} {'{{remaining}}'} 等，按模板上下文替换。
      </p>
      {MESSAGE_FIELDS.map((field) => (
        <label key={field.key} className="cfg-message">
          <span>
            <strong>{field.label}</strong>
            <small>{field.key}</small>
          </span>
          <textarea
            rows={field.key.includes('Countdown') && field.key.length < 18 ? 2 : 4}
            value={value[field.key] ?? ''}
            onChange={(event) =>
              onChange({ ...value, [field.key]: event.target.value })
            }
          />
        </label>
      ))}
    </Section>
  );
}

/** 把表单里的展示值还原成接口需要的结构 */
function serializeConfig(key: string, draft: Row): Row {
  if (key === 'hand') {
    const multipliers: Record<string, number> = {};
    for (const item of HAND_TYPES) {
      multipliers[item.key] = intOrThrow(
        String(draft.multipliers?.[item.key] ?? ''),
        `${item.label}倍数`,
      );
    }
    const normalMultipliers: Record<string, number> = {};
    for (const point of NORMAL_POINTS) {
      const raw = draft.normalMultipliers?.[point] ?? draft.normalMultipliers?.[String(point)];
      normalMultipliers[String(point)] = intOrThrow(String(raw ?? ''), `${point}点倍数`);
    }
    return {
      multipliers,
      normalMultipliers,
      bustThreshold: intOrThrow(String(draft.bustThreshold ?? ''), '自爆门槛'),
      bustExemptSpecialHands: draft.bustExemptSpecialHands !== false,
    };
  }

  if (key === 'betting') {
    const tiers = Array.isArray(draft.playerCoefTiers)
      ? draft.playerCoefTiers.map((tier: Row, index: number) => ({
          maxPlayers: intOrThrow(String(tier.maxPlayers ?? ''), `分档${index + 1}人数上限`),
          coef: numOrThrow(String(tier.coef ?? ''), `分档${index + 1}系数`),
        }))
      : [];
    if (!tiers.length) throw new Error('至少保留一档人数系数');
    return {
      betMinCents:
        typeof draft.betMinCents === 'string'
          ? rmToCents(draft.betMinCents)
          : intOrThrow(String(draft.betMinCents ?? ''), '普通下注最低'),
      shMinCents:
        typeof draft.shMinCents === 'string'
          ? rmToCents(draft.shMinCents)
          : intOrThrow(String(draft.shMinCents ?? ''), '梭哈最低'),
      betRatio:
        typeof draft.betRatio === 'string'
          ? percentToRatio(draft.betRatio)
          : numOrThrow(String(draft.betRatio ?? ''), '普通下注比例'),
      shRatio:
        typeof draft.shRatio === 'string'
          ? percentToRatio(draft.shRatio)
          : numOrThrow(String(draft.shRatio ?? ''), '梭哈比例'),
      playerCoefTiers: tiers,
    };
  }

  if (key === 'fees') {
    return {
      bankerSeatFeeRatio:
        typeof draft.bankerSeatFeeRatio === 'string'
          ? percentToRatio(draft.bankerSeatFeeRatio)
          : numOrThrow(String(draft.bankerSeatFeeRatio ?? ''), '上庄费比例'),
      serviceFeeCents:
        typeof draft.serviceFeeCents === 'string'
          ? rmToCents(draft.serviceFeeCents)
          : intOrThrow(String(draft.serviceFeeCents ?? ''), '服务费'),
      packetPerHeadCents:
        typeof draft.packetPerHeadCents === 'string'
          ? rmToCents(draft.packetPerHeadCents)
          : intOrThrow(String(draft.packetPerHeadCents ?? ''), '红包人均'),
      playerRakeRatio:
        typeof draft.playerRakeRatio === 'string'
          ? percentToRatio(draft.playerRakeRatio)
          : numOrThrow(String(draft.playerRakeRatio ?? ''), '玩家赢抽水比例'),
      bankerRakeRatio:
        typeof draft.bankerRakeRatio === 'string'
          ? percentToRatio(draft.bankerRakeRatio)
          : numOrThrow(String(draft.bankerRakeRatio ?? ''), '庄家赢抽水比例'),
    };
  }

  if (key === 'round') {
    return {
      bidDurationSeconds: intOrThrow(String(draft.bidDurationSeconds ?? ''), '竞标时长'),
      betDurationSeconds: intOrThrow(String(draft.betDurationSeconds ?? ''), '下注时长'),
      claimDurationSeconds: intOrThrow(String(draft.claimDurationSeconds ?? ''), '抢包时长'),
      continuationWindowSeconds: intOrThrow(
        String(draft.continuationWindowSeconds ?? ''),
        '续庄窗口',
      ),
      bankerBidMinCents:
        typeof draft.bankerBidMinCents === 'string'
          ? rmToCents(draft.bankerBidMinCents)
          : intOrThrow(String(draft.bankerBidMinCents ?? ''), '最低出价'),
      bankerBidMaxCents:
        typeof draft.bankerBidMaxCents === 'string'
          ? rmToCents(draft.bankerBidMaxCents)
          : intOrThrow(String(draft.bankerBidMaxCents ?? ''), '最高出价'),
      trendLength: intOrThrow(String(draft.trendLength ?? ''), '走势条长度'),
      assistantEnabled: draft.assistantEnabled !== false,
      autoStart:
        draft.assistantEnabled === false ? false : Boolean(draft.autoStart),
      autoTailPacketEnabled: Boolean(draft.autoTailPacketEnabled),
      autoPublishPacketEnabled: Boolean(draft.autoPublishPacketEnabled),
      packetChannel: draft.packetChannel === 'INTERNAL' ? 'INTERNAL' : 'TNG',
      tailPackerBankerName: String(draft.tailPackerBankerName ?? '').trim() || '代包手·庄家尾包',
      tailPackerPlayerName: String(draft.tailPackerPlayerName ?? '').trim() || '代包手·闲家尾包',
    };
  }

  if (key === 'rebate') {
    return {
      selfRate:
        typeof draft.selfRate === 'string'
          ? percentToRatio(draft.selfRate)
          : numOrThrow(String(draft.selfRate ?? ''), '自身返水'),
      l1Rate:
        typeof draft.l1Rate === 'string'
          ? percentToRatio(draft.l1Rate)
          : numOrThrow(String(draft.l1Rate ?? ''), '一级返水'),
      l2Rate:
        typeof draft.l2Rate === 'string'
          ? percentToRatio(draft.l2Rate)
          : numOrThrow(String(draft.l2Rate ?? ''), '二级返水'),
      includeTieBets: Boolean(draft.includeTieBets),
    };
  }

  if (key === 'rewards') {
    return {
      minBetCents:
        typeof draft.minBetCents === 'string'
          ? rmToCents(draft.minBetCents)
          : intOrThrow(String(draft.minBetCents ?? ''), '普通下注最低'),
      minAllInCents:
        typeof draft.minAllInCents === 'string'
          ? rmToCents(draft.minAllInCents)
          : intOrThrow(String(draft.minAllInCents ?? ''), '梭哈最低'),
      bankerInstantAmountCents:
        typeof draft.bankerInstantAmountCents === 'string'
          ? rmToCents(draft.bankerInstantAmountCents)
          : intOrThrow(String(draft.bankerInstantAmountCents ?? ''), '庄家即时奖励'),
    };
  }

  if (key === 'leaderboard') {
    const enabledTypes = Array.isArray(draft.enabledTypes)
      ? draft.enabledTypes.filter((item: string) =>
          ['points', 'hands', 'banker'].includes(item),
        )
      : [];
    if (!enabledTypes.length) throw new Error('至少启用一种榜单');
    return {
      topN: intOrThrow(String(draft.topN ?? ''), 'Top N'),
      maskNames: draft.maskNames !== false,
      pointsMetric: 'turnover',
      enabledTypes,
      labels: {
        points: String(draft.labels?.points ?? '积分榜').trim() || '积分榜',
        hands: String(draft.labels?.hands ?? '牌型榜').trim() || '牌型榜',
        banker: String(draft.labels?.banker ?? '打桩榜').trim() || '打桩榜',
      },
    };
  }

  if (key === 'messages') {
    const next: Row = {};
    for (const field of MESSAGE_FIELDS) {
      const text = String(draft[field.key] ?? '').trim();
      if (!text) throw new Error(`请填写「${field.label}」`);
      next[field.key] = text;
    }
    return next;
  }

  return { ...draft };
}

/** 加载后把金额/比例转成表单友好展示（RM / %） */
function toFormDraft(key: string, raw: Row): Row {
  if (key === 'betting') {
    return {
      ...raw,
      betMinCents: centsToRm(raw.betMinCents),
      shMinCents: centsToRm(raw.shMinCents),
      betRatio: ratioToPercent(raw.betRatio),
      shRatio: ratioToPercent(raw.shRatio),
      playerCoefTiers: Array.isArray(raw.playerCoefTiers)
        ? raw.playerCoefTiers
        : [],
    };
  }
  if (key === 'fees') {
    // 旧配置只有单一 rakeRatio：作为两侧初始值展示，保存后即写入分侧字段
    const legacyRake = raw.rakeRatio;
    return {
      ...raw,
      bankerSeatFeeRatio: ratioToPercent(raw.bankerSeatFeeRatio),
      serviceFeeCents: centsToRm(raw.serviceFeeCents),
      packetPerHeadCents: centsToRm(raw.packetPerHeadCents),
      playerRakeRatio: ratioToPercent(raw.playerRakeRatio ?? legacyRake ?? 0.03),
      bankerRakeRatio: ratioToPercent(raw.bankerRakeRatio ?? legacyRake ?? 0.05),
    };
  }
  if (key === 'round') {
    return {
      ...raw,
      bankerBidMinCents: centsToRm(raw.bankerBidMinCents),
      bankerBidMaxCents: centsToRm(raw.bankerBidMaxCents),
    };
  }
  if (key === 'rebate') {
    return {
      ...raw,
      selfRate: ratioToPercent(raw.selfRate),
      l1Rate: ratioToPercent(raw.l1Rate),
      l2Rate: ratioToPercent(raw.l2Rate),
    };
  }
  if (key === 'rewards') {
    return {
      ...raw,
      minBetCents: centsToRm(raw.minBetCents),
      minAllInCents: centsToRm(raw.minAllInCents),
      bankerInstantAmountCents: centsToRm(raw.bankerInstantAmountCents),
    };
  }
  return { ...raw };
}

export default function GameConfigEditor({ gameCode }: { gameCode: string }) {
  const [items, setItems] = useState<Row[]>([]);
  const [key, setKey] = useState('hand');
  const [draft, setDraft] = useState<Row>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await request<{ items: Row[] }>(
      `/api/admin/games/${encodeURIComponent(gameCode)}/config`,
    );
    setItems(response.items);
  }

  useEffect(() => {
    void load().catch((error) => setMessage((error as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameCode]);

  useEffect(() => {
    const current = items.find((item) => item.key === key);
    setDraft(toFormDraft(key, (current?.value as Row) ?? {}));
  }, [items, key]);

  const form = useMemo(() => {
    const props = { value: draft, onChange: setDraft };
    switch (key) {
      case 'hand':
        return <HandForm {...props} />;
      case 'betting':
        return <BettingForm {...props} />;
      case 'fees':
        return <FeesForm {...props} />;
      case 'round':
        return <RoundForm {...props} />;
      case 'rebate':
        return <RebateForm {...props} />;
      case 'rewards':
        return <RewardsForm {...props} />;
      case 'leaderboard':
        return <LeaderboardForm {...props} />;
      case 'messages':
        return <MessagesForm {...props} />;
      default:
        return <p className="cfg-help">暂不支持该分类的表单编辑。</p>;
    }
  }, [key, draft]);

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const parsed = serializeConfig(key, draft);
      if (
        !window.confirm(
          `确认保存「${configMeta[key]?.label ?? key}」？修改仅对下一局生效。`,
        )
      ) {
        return;
      }
      await put(`/api/admin/games/${encodeURIComponent(gameCode)}/config`, {
        key,
        value: parsed,
      });
      await load();
      setMessage('配置已保存；进行中牌局继续使用原快照，下一局生效。');
    } catch (error) {
      setMessage(`保存失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel game-config-editor">
      <div className="panel-title">
        <div>
          <small>结构化配置</small>
          <h2>数值与运行规则</h2>
        </div>
        <span>命名空间 · {gameCode}</span>
      </div>
      <div className="game-config-layout">
        <nav className="game-config-nav" aria-label="配置分类">
          {Object.entries(configMeta).map(([valueKey, meta]) => (
            <button
              type="button"
              key={valueKey}
              className={key === valueKey ? 'active' : ''}
              onClick={() => setKey(valueKey)}
            >
              <strong>{meta.label}</strong>
              <span>{meta.hint}</span>
            </button>
          ))}
        </nav>
        <div className="game-config-body">
          <header>
            <div>
              <small>{key}</small>
              <strong>{configMeta[key]?.label ?? key}</strong>
            </div>
            <span>表单填写 · 金额用 RM，比例用 %</span>
          </header>
          <div className="cfg-form">{form}</div>
          <footer>
            <p>保存不会改变进行中牌局；新局开局时会冻结完整配置快照。</p>
            <button
              type="button"
              className="primary small"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? '保存中…' : '保存配置'}
            </button>
          </footer>
          <Notice message={message} />
        </div>
      </div>
    </section>
  );
}

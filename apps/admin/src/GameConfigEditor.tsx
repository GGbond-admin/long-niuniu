import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { put, request } from './api';

type Row = Record<string, any>;

const configMeta: Record<string, { label: string; hint: string }> = {
  hand: { label: '牌型规则', hint: '牌型倍数、爆点门槛与特殊牌型' },
  betting: { label: '下注规则', hint: '普通下注、梭哈满额比例与最低额' },
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
  { key: 'SHUNZI', label: '顺子' },
  { key: 'FANSHUN', label: '反顺' },
  { key: 'DUIZI', label: '对子' },
  { key: 'JINNIU', label: '金牛' },
  { key: 'NIUNIU', label: '牛牛（三位相加=10）' },
  { key: 'NORMAL', label: '普通（占位，实际用下方点数倍数）' },
];

const NORMAL_POINTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

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
  { key: 'dicePrompt', label: '庄家确认提示' },
  { key: 'bankerDice', label: '庄家开骰结果' },
  { key: 'claimStart', label: '开始抢包' },
  { key: 'claimWarning', label: '领包提醒（已并入开始抢包，不再单独发送）' },
  { key: 'claimCountdown', label: '抢包倒计时' },
  { key: 'claimExpiredEdit', label: '抢包结束（编辑中）' },
  { key: 'claimExpired', label: '抢包结束' },
  { key: 'rakeNotice', label: '抽水通告' },
  { key: 'settlingWait', label: '结算中' },
  { key: 'cancelled', label: '本局取消' },
  { key: 'continuationPrompt', label: '续庄询问' },
  { key: 'rewardCongrats', label: '奖励到账' },
];

function formatConfigSaveError(error: unknown): string {
  const err = error as Error & {
    issues?: Array<{
      path?: Array<string | number>;
      message?: string;
      code?: string;
      keys?: string[];
      maximum?: number;
      minimum?: number;
    }>;
  };
  const issue = err.issues?.[0];
  if (!issue) return err.message || '保存失败';
  const FIELD_LABELS: Record<string, string> = {
    betRatio: '普通下注比例',
    shRatio: '梭哈比例',
    betMinCents: '普通下注最低',
    shMinCents: '梭哈最低',
    bankerSeatFeeRatio: '上庄费比例',
    serviceFeeCents: '服务费',
    packetPerHeadCents: '红包人均单价',
    playerRakeRatio: '玩家赢抽水比例',
    bankerRakeRatio: '庄家盈利抽水比例',
    selfRate: '自身返水',
    l1Rate: '一级返水',
    l2Rate: '二级返水',
    bankerBidMinCents: '上庄起拍价',
    bankerBidMaxCents: '最高出价',
    nextRoundDelaySeconds: '成绩单后开下一局',
    minBetCents: '奖励普通最低',
    minAllInCents: '奖励梭哈最低',
  };
  const path = (issue.path ?? []).map(String).join('.');
  const label = FIELD_LABELS[path] ?? path;
  if (issue.message && /[\u4e00-\u9fff]/.test(issue.message)) {
    return issue.message;
  }
  if (issue.code === 'too_big') {
    return `${label || '数值'}超出允许范围`;
  }
  if (issue.code === 'too_small') {
    return `${label || '数值'}低于允许范围`;
  }
  if (issue.code === 'unrecognized_keys') {
    return `包含已停用字段：${(issue.keys ?? []).join('、')}`;
  }
  return issue.message || err.message || '提交的资料格式有误';
}

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

function percentField(value: unknown, label: string): number {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`请填写「${label}」`);
  return percentToRatio(text);
}

function moneyField(value: unknown, label: string): number {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`请填写「${label}」`);
  return rmToCents(text);
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
      <Section title="特殊牌型倍数（0.01免死；全表最高倍数=普通下注赔付预留倍数，默认17倍；梭哈固定1:1、预留1倍）">
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
      <Section title="普通牌型点数倍数（0–9 点；相加=10 已归入「牛牛」牌型，相加=20 等记 0 点）">
        {NORMAL_POINTS.map((point) => (
          <Field
            key={point}
            label={point === 0 ? '0 点（最小点数）' : `${point} 点`}
            hint="倍"
          >
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={
                normal[point]
                ?? normal[String(point)]
                ?? (point === 0 ? (normal[10] ?? normal['10']) : undefined)
                ?? ''
              }
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
        <Field label="自爆开关" hint="关闭后普通低点也按正常比牌，不再直接判输">
          <select
            value={value.bustEnabled === false ? '0' : '1'}
            onChange={(event) =>
              onChange({ ...value, bustEnabled: event.target.value === '1' })
            }
          >
            <option value="1">开启</option>
            <option value="0">关闭</option>
          </select>
        </Field>
        <Field label="自爆门槛" hint="点数 ≤ 此值判自爆（0–10）；特殊牌型固定不自爆">
          <input
            type="number"
            min={0}
            max={10}
            step={1}
            disabled={value.bustEnabled === false}
            value={value.bustThreshold ?? ''}
            onChange={(event) =>
              onChange({ ...value, bustThreshold: Number(event.target.value) })
            }
          />
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
  return (
    <>
      <Section title="下注金额下限">
        <Field label="普通下注最低" hint="RM">
          <input
            inputMode="decimal"
            value={value.betMinCents ?? ''}
            onChange={(event) =>
              onChange({ ...value, betMinCents: event.target.value })
            }
          />
        </Field>
        <Field label="梭哈最低" hint="RM；梭哈固定 1:1，最高额 = 庄钱 × 梭哈比例">
          <input
            inputMode="decimal"
            value={value.shMinCents ?? ''}
            onChange={(event) =>
              onChange({ ...value, shMinCents: event.target.value })
            }
          />
        </Field>
      </Section>
      <Section title="上限比例（相对庄钱）">
        <Field label="普通下注比例" hint="% ，满注。例如 0.5 表示上庄 10000 时上限 RM50">
          <input
            value={value.betRatio ?? ''}
            onChange={(event) =>
              onChange({ ...value, betRatio: event.target.value })
            }
          />
        </Field>
        <Field label="梭哈比例" hint="% ，满梭哈。例如 5 表示上庄 10000 时上限 RM500">
          <input
            value={value.shRatio ?? ''}
            onChange={(event) =>
              onChange({ ...value, shRatio: event.target.value })
            }
          />
        </Field>
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
          value={value.bankerSeatFeeRatio ?? ''}
          onChange={(event) =>
            onChange({ ...value, bankerSeatFeeRatio: event.target.value })
          }
        />
      </Field>
      <Field label="服务费（每场固定）" hint="RM">
        <input
          inputMode="decimal"
          value={value.serviceFeeCents ?? ''}
          onChange={(event) =>
            onChange({ ...value, serviceFeeCents: event.target.value })
          }
        />
      </Field>
      <Field label="红包人均单价" hint="RM / 人">
        <input
          inputMode="decimal"
          value={value.packetPerHeadCents ?? ''}
          onChange={(event) =>
            onChange({ ...value, packetPerHeadCents: event.target.value })
          }
        />
      </Field>
      <Field label="玩家赢抽水比例" hint="% ，只抽闲家赢方盈利，例如 3 = 3%">
        <input
          value={value.playerRakeRatio ?? ''}
          onChange={(event) =>
            onChange({ ...value, playerRakeRatio: event.target.value })
          }
        />
      </Field>
      <Field label="庄家盈利抽水比例" hint="% ，按本局对赌毛利（实收−实赔）抽取，亏损不抽。例如 5 = 5%">
        <input
          value={value.bankerRakeRatio ?? ''}
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
        <Field
          label="续庄确认窗口"
          hint="庄家确认是否续庄的秒数；未确认则转入公开竞标"
        >
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
        <Field
          label="成绩单后开下一局"
          hint="公布成绩单后等待几秒再自动开下一局，默认 10 秒。续庄确认可同时进行。"
        >
          <input
            type="number"
            min={3}
            max={300}
            value={value.nextRoundDelaySeconds ?? ''}
            onChange={(event) =>
              onChange({
                ...value,
                nextRoundDelaySeconds: Number(event.target.value),
              })
            }
          />
        </Field>
        <Field
          label="庄家确认时限"
          hint="封盘后庄家有这么多秒选择「投骰开包」或「重推退款」；超时自动取消并原路退款"
        >
          <input
            type="number"
            min={5}
            max={120}
            value={value.bankerDiceTimeoutSeconds ?? ''}
            onChange={(event) =>
              onChange({
                ...value,
                bankerDiceTimeoutSeconds: Number(event.target.value),
              })
            }
          />
        </Field>
      </Section>
      <Section title="竞标金额范围">
        <Field
          label="上庄起拍价"
          hint="RM，玩家首次出价不得低于此金额；下一局生效"
        >
          <input
            inputMode="decimal"
            value={value.bankerBidMinCents ?? ''}
            onChange={(event) =>
              onChange({ ...value, bankerBidMinCents: event.target.value })
            }
          />
        </Field>
        <Field label="最高出价" hint="RM">
          <input
            inputMode="decimal"
            value={value.bankerBidMaxCents ?? ''}
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
          hint="TNG=运营粘贴链接、玩家跳转外部抢包；系统红包=投骰后由至尊牛牛小助手自动发包，玩家群内直抢并即时入余额"
        >
          <select
            value={value.packetChannel === 'INTERNAL' ? 'INTERNAL' : 'TNG'}
            onChange={(event) =>
              onChange({ ...value, packetChannel: event.target.value })
            }
          >
            <option value="TNG">TNG 链接</option>
            <option value="INTERNAL">系统红包（至尊牛牛小助手）</option>
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
          value={value.selfRate ?? ''}
          onChange={(event) =>
            onChange({ ...value, selfRate: event.target.value })
          }
        />
      </Field>
      <Field label="一级（直属）返水" hint="%">
        <input
          value={value.l1Rate ?? ''}
          onChange={(event) =>
            onChange({ ...value, l1Rate: event.target.value })
          }
        />
      </Field>
      <Field label="二级返水" hint="%">
        <input
          value={value.l2Rate ?? ''}
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
          value={value.minBetCents ?? ''}
          onChange={(event) =>
            onChange({ ...value, minBetCents: event.target.value })
          }
        />
      </Field>
      <Field label="梭哈最低" hint="RM">
        <input
          value={value.minAllInCents ?? ''}
          onChange={(event) =>
            onChange({ ...value, minAllInCents: event.target.value })
          }
        />
      </Field>
      <Field label="庄家即时奖励金额" hint="RM">
        <input
          value={value.bankerInstantAmountCents ?? ''}
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
      const raw =
        draft.normalMultipliers?.[point]
        ?? draft.normalMultipliers?.[String(point)]
        ?? (point === 0
          ? (draft.normalMultipliers?.[10] ?? draft.normalMultipliers?.['10'])
          : undefined);
      normalMultipliers[String(point)] = intOrThrow(String(raw ?? ''), `${point}点倍数`);
    }
    return {
      multipliers,
      normalMultipliers,
      bustEnabled: draft.bustEnabled !== false,
      bustThreshold: intOrThrow(String(draft.bustThreshold ?? ''), '自爆门槛'),
    };
  }

  if (key === 'betting') {
    return {
      betMinCents: moneyField(draft.betMinCents, '普通下注最低'),
      shMinCents: moneyField(draft.shMinCents, '梭哈最低'),
      betRatio: percentField(draft.betRatio, '普通下注比例'),
      shRatio: percentField(draft.shRatio, '梭哈比例'),
    };
  }

  if (key === 'fees') {
    return {
      bankerSeatFeeRatio: percentField(draft.bankerSeatFeeRatio, '上庄费比例'),
      serviceFeeCents: moneyField(draft.serviceFeeCents, '服务费'),
      packetPerHeadCents: moneyField(draft.packetPerHeadCents, '红包人均'),
      playerRakeRatio: percentField(draft.playerRakeRatio, '玩家赢抽水比例'),
      bankerRakeRatio: percentField(draft.bankerRakeRatio, '庄家盈利抽水比例'),
    };
  }

  if (key === 'round') {
    const choiceSeconds = intOrThrow(
      String(draft.bankerDiceTimeoutSeconds ?? ''),
      '庄家确认时限',
    );
    return {
      bidDurationSeconds: intOrThrow(String(draft.bidDurationSeconds ?? ''), '竞标时长'),
      betDurationSeconds: intOrThrow(String(draft.betDurationSeconds ?? ''), '下注时长'),
      claimDurationSeconds: intOrThrow(String(draft.claimDurationSeconds ?? ''), '抢包时长'),
      continuationWindowSeconds: intOrThrow(
        String(draft.continuationWindowSeconds ?? ''),
        '续庄窗口',
      ),
      nextRoundDelaySeconds: intOrThrow(
        String(draft.nextRoundDelaySeconds ?? 10),
        '成绩单后开下一局',
      ),
      bankerDiceTimeoutSeconds: choiceSeconds,
      repostWindowSeconds: choiceSeconds,
      bankerBidMinCents: moneyField(draft.bankerBidMinCents, '上庄起拍价'),
      bankerBidMaxCents: moneyField(draft.bankerBidMaxCents, '最高出价'),
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
      selfRate: percentField(draft.selfRate, '自身返水'),
      l1Rate: percentField(draft.l1Rate, '一级返水'),
      l2Rate: percentField(draft.l2Rate, '二级返水'),
      includeTieBets: Boolean(draft.includeTieBets),
    };
  }

  if (key === 'rewards') {
    return {
      minBetCents: moneyField(draft.minBetCents, '普通下注最低'),
      minAllInCents: moneyField(draft.minAllInCents, '梭哈最低'),
      bankerInstantAmountCents: moneyField(draft.bankerInstantAmountCents, '庄家即时奖励'),
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
      setMessage(`保存失败：${formatConfigSaveError(error)}`);
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

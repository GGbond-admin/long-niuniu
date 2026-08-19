import { useEffect, useMemo, useState } from 'react';
import { post, request, rm } from '../api';
import type {
  BatchDetail,
  ProfitPoolPreview,
  ProfitPoolRoom,
  RangeCheck,
} from './types';

function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试';
}

function signedRm(cents: string) {
  const value = BigInt(cents || 0);
  return `${value < 0n ? '−' : ''}RM ${rm(value < 0n ? -value : value)}`;
}

function percentToBps(value: string): number | null {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(percent * 100);
}

function StepIcon({ done }: { done: boolean }) {
  return done ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12.5 4.2 4.2L19 7" />
    </svg>
  ) : null;
}

function AgentAllocationTable({
  preview,
  compact = false,
}: {
  preview: ProfitPoolPreview;
  compact?: boolean;
}) {
  return (
    <section className={`ppx-preview-agents ${compact ? 'compact' : ''}`}>
      <header>
        <div>
          <small>AGENT ALLOCATION PREVIEW</small>
          <h4>代理分配明细</h4>
        </div>
        <span>{preview.agents.length} 位代理 · 生成后按此快照永久保存</span>
      </header>
      <div>
        <table>
          <thead>
            <tr>
              <th>代理</th>
              <th>占成</th>
              <th>自身 / 团队流水</th>
              <th>自身利润</th>
              <th>下级差额</th>
              <th>合计</th>
            </tr>
          </thead>
          <tbody>
            {preview.agents.map((agent) => (
              <tr key={agent.agentId}>
                <td>
                  <strong>{agent.label}</strong>
                  <small>{agent.nickname ?? agent.uid} · L{agent.level}</small>
                </td>
                <td>{agent.sharePoints}/{preview.bucketBase}</td>
                <td>
                  {signedRm(agent.selfTurnoverCents)}
                  <small>{signedRm(agent.teamTurnoverCents)}</small>
                </td>
                <td>{signedRm(agent.selfAmountCents)}</td>
                <td>{signedRm(agent.overrideAmountCents)}</td>
                <td><strong>{signedRm(agent.amountCents)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview.agents.length === 0 && (
          <p>当前没有代理快照，本批利润将全部保留在公司利润池。</p>
        )}
      </div>
    </section>
  );
}

export default function SettlementWizard({
  defaultExpenseRatio = 0.025,
  onGenerated,
  onError,
}: {
  defaultExpenseRatio?: number;
  onGenerated: (poolId: string, poolCode: string) => void;
  onError: (message: string) => void;
}) {
  const [rooms, setRooms] = useState<ProfitPoolRoom[]>([]);
  const [roomId, setRoomId] = useState('');
  const [startSeqNo, setStartSeqNo] = useState('');
  const [endSeqNo, setEndSeqNo] = useState('');
  const [expensePercent, setExpensePercent] = useState(
    (defaultExpenseRatio * 100).toFixed(2),
  );
  const [expenseDirty, setExpenseDirty] = useState(false);
  const [step, setStep] = useState(1);
  const [rangeCheck, setRangeCheck] = useState<RangeCheck | null>(null);
  const [preview, setPreview] = useState<ProfitPoolPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [generated, setGenerated] = useState<{ id: string; code: string } | null>(null);

  useEffect(() => {
    request<{ items: ProfitPoolRoom[] }>('/api/admin/profit-pool/rooms')
      .then(({ items }) => {
        setRooms(items);
        const first = items[0];
        if (first) {
          setRoomId(first.id);
          setStartSeqNo(String(first.nextAvailableSeqNo));
          setEndSeqNo(String(first.maxTerminalSeqNo));
        }
      })
      .catch((error) => onError(errorText(error)))
      .finally(() => setLoadingRooms(false));
  }, [onError]);

  useEffect(() => {
    if (!expenseDirty) {
      setExpensePercent((defaultExpenseRatio * 100).toFixed(2));
    }
  }, [defaultExpenseRatio, expenseDirty]);

  const selectedRoom = rooms.find((room) => room.id === roomId) ?? null;
  const expenseBps = useMemo(() => percentToBps(expensePercent), [expensePercent]);
  const selectionValid =
    Boolean(roomId) &&
    Number.isInteger(Number(startSeqNo)) &&
    Number.isInteger(Number(endSeqNo)) &&
    Number(startSeqNo) > 0 &&
    Number(endSeqNo) >= Number(startSeqNo);

  function updateRoom(nextRoomId: string) {
    const room = rooms.find((item) => item.id === nextRoomId);
    setRoomId(nextRoomId);
    setStartSeqNo(String(room?.nextAvailableSeqNo ?? 1));
    setEndSeqNo(String(room?.maxTerminalSeqNo ?? 0));
    setRangeCheck(null);
    setPreview(null);
    setStep(1);
  }

  function updateRange(
    setter: (value: string) => void,
    value: string,
  ) {
    setter(value);
    setRangeCheck(null);
    setPreview(null);
    setStep(1);
  }

  async function checkRange() {
    if (!selectionValid) return;
    setBusy(true);
    onError('');
    try {
      const result = await post<RangeCheck>('/api/admin/profit-pool/range/check', {
        roomId,
        startSeqNo: Number(startSeqNo),
        endSeqNo: Number(endSeqNo),
      });
      setRangeCheck(result);
      setStep(2);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function createPreview() {
    if (!rangeCheck || expenseBps === null) return;
    setBusy(true);
    onError('');
    try {
      const result = await post<{ preview: ProfitPoolPreview }>(
        '/api/admin/profit-pool/preview',
        {
          roomId,
          startSeqNo: Number(startSeqNo),
          endSeqNo: Number(endSeqNo),
          expenseBps,
        },
      );
      setPreview(result.preview);
      setStep(3);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!preview) return;
    setBusy(true);
    onError('');
    try {
      const result = await post<{ pool: BatchDetail }>(
        '/api/admin/profit-pool/generate',
        {
          roomId,
          startSeqNo: Number(startSeqNo),
          endSeqNo: Number(endSeqNo),
          expenseBps: preview.expenseBps,
          calculationHash: preview.calculationHash,
        },
      );
      setGenerated({ id: result.pool.id, code: result.pool.poolCode });
      onGenerated(result.pool.id, result.pool.poolCode);
    } catch (error) {
      onError(errorText(error));
      setStep(2);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const steps = ['选择局数', '填写支出比例', '核对报表', '确认生成'];

  if (generated) {
    return (
      <section className="ppx-wizard ppx-success" aria-live="polite">
        <div className="ppx-success-mark">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 12.5 4.2 4.2L19 7" />
          </svg>
        </div>
        <small>利润池生成成功</small>
        <h2>{generated.code}</h2>
        <p>
          第 {startSeqNo}–{endSeqNo} 局已经永久锁定。报表当前为“待分配”，核对后再执行发放。
        </p>
        <div className="ppx-success-actions">
          <button
            type="button"
            className="primary"
            onClick={() => onGenerated(generated.id, generated.code)}
          >
            查看完整报表
          </button>
          <button
            type="button"
            onClick={() => {
              setGenerated(null);
              setPreview(null);
              setRangeCheck(null);
              setStep(1);
              if (selectedRoom) {
                const next = Number(endSeqNo) + 1;
                setStartSeqNo(String(next));
                setEndSeqNo(String(selectedRoom.maxTerminalSeqNo));
              }
            }}
          >
            生成下一批
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="ppx-wizard" aria-labelledby="ppx-wizard-title">
      <header className="ppx-wizard-head">
        <div>
          <small>ROUND-RANGE SETTLEMENT</small>
          <h2 id="ppx-wizard-title">生成称桶利润池</h2>
          <p>按单一游戏房间的连续局号结算；正式生成后，局数不可再次使用。</p>
        </div>
        <span className="ppx-lock-note">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="10" width="14" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
          数据库永久锁局
        </span>
      </header>

      <ol className="ppx-stepper" aria-label="生成进度">
        {steps.map((label, index) => {
          const number = index + 1;
          const done = step > number;
          return (
            <li
              key={label}
              className={step === number ? 'active' : done ? 'done' : ''}
              aria-current={step === number ? 'step' : undefined}
            >
              <i>{done ? <StepIcon done /> : number}</i>
              <span>{label}</span>
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div className="ppx-stage">
          <div className="ppx-stage-copy">
            <span>01</span>
            <div>
              <h3>选择游戏局数</h3>
              <p>闭区间内每一个局号都必须存在，并且只能是“已完成”或“已取消”。</p>
            </div>
          </div>
          <div className="ppx-range-form">
            <label className="ppx-field wide">
              <span>游戏房间 <em>必选</em></span>
              <select
                value={roomId}
                disabled={loadingRooms || busy}
                onChange={(event) => updateRoom(event.target.value)}
              >
                {rooms.map((room) => (
                  <option value={room.id} key={room.id}>
                    {room.title} · 已结束至第 {room.maxTerminalSeqNo} 局
                  </option>
                ))}
              </select>
              {selectedRoom && (
                <small>
                  旧账安全边界：第 {selectedRoom.cutoverSeqNo} 局 · 建议从第{' '}
                  {selectedRoom.nextAvailableSeqNo} 局开始
                </small>
              )}
            </label>
            <label className="ppx-field">
              <span>开始局数 <em>必填</em></span>
              <div className="ppx-seq-input">
                <b>第</b>
                <input
                  type="number"
                  min={1}
                  value={startSeqNo}
                  disabled={busy}
                  onChange={(event) => updateRange(setStartSeqNo, event.target.value)}
                />
                <b>局</b>
              </div>
            </label>
            <div className="ppx-range-arrow" aria-hidden="true">→</div>
            <label className="ppx-field">
              <span>结束局数 <em>必填</em></span>
              <div className="ppx-seq-input">
                <b>第</b>
                <input
                  type="number"
                  min={1}
                  value={endSeqNo}
                  disabled={busy}
                  onChange={(event) => updateRange(setEndSeqNo, event.target.value)}
                />
                <b>局</b>
              </div>
            </label>
          </div>
          <div className="ppx-stage-actions">
            <span>
              {selectionValid
                ? `将检查 ${Number(endSeqNo) - Number(startSeqNo) + 1} 个连续局号`
                : selectedRoom && Number(startSeqNo) > selectedRoom.maxTerminalSeqNo
                  ? '建议起点后暂无已结束局；如需补结空档，请手动输入局号'
                  : '请输入有效的开始和结束局数'}
            </span>
            <button
              type="button"
              className="primary"
              disabled={!selectionValid || busy}
              onClick={() => void checkRange()}
            >
              {busy ? '正在检查…' : '检查范围并继续'}
            </button>
          </div>
        </div>
      )}

      {step === 2 && rangeCheck && (
        <div className="ppx-stage">
          <div className="ppx-stage-copy">
            <span>02</span>
            <div>
              <h3>填写公司支出百分比</h3>
              <p>本次比例只写入本批快照；之后修改默认参数不会改变历史报表。</p>
            </div>
          </div>
          <div className="ppx-range-approved" role="status">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 12.5 4.2 4.2L19 7" />
            </svg>
            <div>
              <strong>局数范围可用，可以继续下一步</strong>
              <small>
                第 {rangeCheck.startSeqNo}–{rangeCheck.endSeqNo} 局 · 共{' '}
                {rangeCheck.roundCount} 局（完成 {rangeCheck.finishedRoundCount} / 取消{' '}
                {rangeCheck.cancelledRoundCount}）
              </small>
            </div>
          </div>
          <label className={`ppx-expense-field ${expenseBps === null ? 'invalid' : ''}`}>
            <span>
              本次报表公司支出百分比 <em>必填</em>
            </span>
            <div>
              <input
                inputMode="decimal"
                value={expensePercent}
                disabled={busy}
                onChange={(event) => {
                  setExpenseDirty(true);
                  setExpensePercent(event.target.value);
                  setPreview(null);
                }}
                aria-invalid={expenseBps === null}
              />
              <b>%</b>
            </div>
            <small>
              公司支出 = 总流水 × 支出百分比；最多两位小数，允许明确填写 0%。
            </small>
          </label>
          <div className="ppx-stage-actions">
            <button type="button" onClick={() => setStep(1)} disabled={busy}>
              上一步
            </button>
            <button
              type="button"
              className="primary"
              disabled={expenseBps === null || busy}
              onClick={() => void createPreview()}
            >
              {busy ? '正在计算…' : '生成核对报表'}
            </button>
          </div>
        </div>
      )}

      {step === 3 && preview && (
        <div className="ppx-stage">
          <div className="ppx-stage-copy">
            <span>03</span>
            <div>
              <h3>核对结算数据</h3>
              <p>所有金额由服务端从逐局结算记录重算，前端不能直接修改利润。</p>
            </div>
          </div>
          <div className="ppx-preview-grid">
            <article>
              <small>公司总流水</small>
              <strong>{signedRm(preview.financials.turnoverCents)}</strong>
              <span>
                闲 {signedRm(preview.financials.turnoverPlayerCents)} · 庄{' '}
                {signedRm(preview.financials.turnoverBankerCents)}
              </span>
            </article>
            <article>
              <small>玩家赢抽水</small>
              <strong>{signedRm(preview.financials.rakePlayerCents)}</strong>
              <span>逐笔实收汇总</span>
            </article>
            <article>
              <small>庄家赢抽水</small>
              <strong>{signedRm(preview.financials.rakeBankerCents)}</strong>
              <span>逐笔实收汇总</span>
            </article>
            <article className="total">
              <small>总抽水利润</small>
              <strong>{signedRm(preview.financials.rakeTotalCents)}</strong>
              <span>玩家赢 + 庄家赢</span>
            </article>
            <article className="expense">
              <small>公司支出 · {(preview.expenseBps / 100).toFixed(2)}%</small>
              <strong>−RM {rm(preview.expenseCents)}</strong>
              <span>总流水 × 本次支出比例</span>
            </article>
            <article className="net">
              <small>最终可分配利润池</small>
              <strong>{signedRm(preview.netPoolCents)}</strong>
              <span>总抽水利润 − 公司支出</span>
            </article>
            <article className="allocation">
              <small>代理分配合计</small>
              <strong>{signedRm(preview.distributedCents)}</strong>
              <span>自身利润 + 下级差额利润</span>
            </article>
            <article className="residual">
              <small>公司最终留存</small>
              <strong>{signedRm(preview.residualCents)}</strong>
              <span>利润池 − 代理分配</span>
            </article>
            <article>
              <small>公司剩余点数</small>
              <strong>
                {(preview.companyRemainingPointsHundredths / 100).toFixed(2)}
              </strong>
              <span>称桶基准 {preview.bucketBase} 点</span>
            </article>
          </div>
          <div className="ppx-equation" aria-label="利润池计算公式">
            <span>{signedRm(preview.financials.rakeTotalCents)}</span>
            <i>−</i>
            <span>{signedRm(preview.expenseCents)}</span>
            <i>=</i>
            <strong>{signedRm(preview.netPoolCents)}</strong>
          </div>
          <AgentAllocationTable preview={preview} />
          <div className="ppx-stage-actions">
            <button type="button" onClick={() => setStep(2)} disabled={busy}>
              上一步
            </button>
            <button type="button" className="primary" onClick={() => setStep(4)}>
              生成称桶利润池
            </button>
          </div>
        </div>
      )}

      {step === 4 && preview && (
        <div className="ppx-stage ppx-confirm-stage">
          <div className="ppx-stage-copy">
            <span>04</span>
            <div>
              <h3>确认生成利润池</h3>
              <p>这是正式账务动作。确认后会生成唯一编号，并永久占用所选局数。</p>
            </div>
          </div>
          <dl className="ppx-confirm-list">
            <div><dt>游戏房间</dt><dd>{preview.room.title}</dd></div>
            <div><dt>本次局数</dt><dd>第 {preview.startSeqNo}–{preview.endSeqNo} 局（共 {preview.roundCount} 局）</dd></div>
            <div><dt>总流水</dt><dd>{signedRm(preview.financials.turnoverCents)}</dd></div>
            <div><dt>总抽水利润</dt><dd>{signedRm(preview.financials.rakeTotalCents)}</dd></div>
            <div><dt>公司支出百分比</dt><dd>{(preview.expenseBps / 100).toFixed(2)}%</dd></div>
            <div><dt>公司支出</dt><dd>−RM {rm(preview.expenseCents)}</dd></div>
            <div className="final"><dt>最终利润池</dt><dd>{signedRm(preview.netPoolCents)}</dd></div>
            <div><dt>代理分配合计</dt><dd>{signedRm(preview.distributedCents)}</dd></div>
            <div><dt>公司最终留存</dt><dd>{signedRm(preview.residualCents)}</dd></div>
            <div><dt>公司剩余点数</dt><dd>{(preview.companyRemainingPointsHundredths / 100).toFixed(2)} / {preview.bucketBase}</dd></div>
          </dl>
          <AgentAllocationTable preview={preview} compact />
          <div className="ppx-permanent-warning">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3 2.8 20h18.4L12 3Z" />
              <path d="M12 9v5M12 17.5v.1" />
            </svg>
            <span>正式生成后不可作废重用局数；待分配状态仍需另行确认发放。</span>
          </div>
          <div className="ppx-stage-actions">
            <button type="button" onClick={() => setStep(3)} disabled={busy}>
              返回核对
            </button>
            <button
              type="button"
              className="primary danger-confirm"
              disabled={busy}
              onClick={() => void generate()}
            >
              {busy ? '正在锁定并生成…' : '确认生成'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

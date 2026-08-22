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
          <h4>代理分配</h4>
        </div>
        <span>{preview.agents.length} 位</span>
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
          setEndSeqNo(String(Math.max(first.nextAvailableSeqNo, first.maxTerminalSeqNo)));
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
  const noAvailableRounds =
    !!selectedRoom && selectedRoom.maxTerminalSeqNo < selectedRoom.nextAvailableSeqNo;
  const selectionValid =
    Boolean(roomId) &&
    !noAvailableRounds &&
    Number.isInteger(Number(startSeqNo)) &&
    Number.isInteger(Number(endSeqNo)) &&
    Number(startSeqNo) > 0 &&
    Number(endSeqNo) >= Number(startSeqNo);

  function updateRoom(nextRoomId: string) {
    const room = rooms.find((item) => item.id === nextRoomId);
    setRoomId(nextRoomId);
    setStartSeqNo(String(room?.nextAvailableSeqNo ?? 1));
    setEndSeqNo(
      String(Math.max(room?.nextAvailableSeqNo ?? 1, room?.maxTerminalSeqNo ?? 0)),
    );
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
      setStartSeqNo(String(result.startSeqNo));
      setEndSeqNo(String(result.endSeqNo));
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
          startSeqNo: rangeCheck.startSeqNo,
          endSeqNo: rangeCheck.endSeqNo,
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
          startSeqNo: preview.startSeqNo,
          endSeqNo: preview.endSeqNo,
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

  const steps = ['局数', '支出', '核对', '生成'];

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
          第 {startSeqNo}–{endSeqNo} 局已锁定。报表为待分配，核对后再发放。
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
          <h2 id="ppx-wizard-title">生成称桶利润池</h2>
          <p>按房间局号结算已完成有效局。生成后局数锁定，未发放前仍可撤回。</p>
        </div>
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
          <div className="ppx-range-form">
            <label className="ppx-field wide">
              <span>房间</span>
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
            </label>
            <label className="ppx-field">
              <span>开始局</span>
              <div className="ppx-seq-input">
                <b>第</b>
                <input
                  type="number"
                  min={1}
                  value={startSeqNo}
                  disabled={busy || noAvailableRounds}
                  onChange={(event) => updateRange(setStartSeqNo, event.target.value)}
                />
                <b>局</b>
              </div>
            </label>
            <div className="ppx-range-arrow" aria-hidden="true">→</div>
            <label className="ppx-field">
              <span>结束局</span>
              <div className="ppx-seq-input">
                <b>第</b>
                <input
                  type="number"
                  min={1}
                  value={endSeqNo}
                  disabled={busy || noAvailableRounds}
                  onChange={(event) => updateRange(setEndSeqNo, event.target.value)}
                />
                <b>局</b>
              </div>
            </label>
          </div>
          <div className="ppx-stage-actions">
            <span>
              {noAvailableRounds
                ? `暂无新的已完成局（建议从第 ${selectedRoom?.nextAvailableSeqNo} 局起）`
                : selectionValid
                  ? `将结算第 ${startSeqNo}–${endSeqNo} 局中的已完成有效局`
                  : '结束局需不小于开始局'}
            </span>
            <button
              type="button"
              className="primary"
              disabled={!selectionValid || busy}
              onClick={() => void checkRange()}
            >
              {busy ? '正在检查…' : '下一步'}
            </button>
          </div>
        </div>
      )}

      {step === 2 && rangeCheck && (
        <div className="ppx-stage">
          <p className="ppx-range-chip">
            第 {rangeCheck.startSeqNo}–{rangeCheck.endSeqNo} 局 · 有效 {rangeCheck.finishedRoundCount} 局
            {rangeCheck.cancelledRoundCount
              ? ` · 取消 ${rangeCheck.cancelledRoundCount} 局不计`
              : ''}
          </p>
          <label className={`ppx-expense-field ${expenseBps === null ? 'invalid' : ''}`}>
            <span>公司支出比例</span>
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
            <small>本批快照专用，最多两位小数，可填 0。</small>
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
              {busy ? '正在计算…' : '下一步'}
            </button>
          </div>
        </div>
      )}

      {step === 3 && preview && (
        <div className="ppx-stage">
          <div className="ppx-preview-grid ppx-preview-grid-lite">
            <article>
              <small>总流水</small>
              <strong>{signedRm(preview.financials.turnoverCents)}</strong>
            </article>
            <article className="expense">
              <small>支出 {(preview.expenseBps / 100).toFixed(2)}%</small>
              <strong>−RM {rm(preview.expenseCents)}</strong>
            </article>
            <article className="net">
              <small>利润池</small>
              <strong>{signedRm(preview.netPoolCents)}</strong>
            </article>
            <article className="allocation">
              <small>代理合计</small>
              <strong>{signedRm(preview.distributedCents)}</strong>
            </article>
            <article className="residual">
              <small>公司留存</small>
              <strong>{signedRm(preview.residualCents)}</strong>
            </article>
          </div>
          <p className="ppx-equation-lite">
            抽水 {signedRm(preview.financials.rakeTotalCents)} − 支出 {signedRm(preview.expenseCents)} = 利润池 {signedRm(preview.netPoolCents)}
          </p>
          <AgentAllocationTable preview={preview} />
          <div className="ppx-stage-actions">
            <button type="button" onClick={() => setStep(2)} disabled={busy}>
              上一步
            </button>
            <button type="button" className="primary" onClick={() => setStep(4)}>
              下一步
            </button>
          </div>
        </div>
      )}

      {step === 4 && preview && (
        <div className="ppx-stage ppx-confirm-stage">
          <dl className="ppx-confirm-list">
            <div>
              <dt>房间 / 局数</dt>
              <dd>
                {preview.room.title} · 第 {preview.startSeqNo}–{preview.endSeqNo} 局（{preview.roundCount} 有效局）
              </dd>
            </div>
            <div>
              <dt>支出</dt>
              <dd>{(preview.expenseBps / 100).toFixed(2)}% · −RM {rm(preview.expenseCents)}</dd>
            </div>
            <div className="final">
              <dt>利润池</dt>
              <dd>{signedRm(preview.netPoolCents)}</dd>
            </div>
            <div>
              <dt>代理 / 留存</dt>
              <dd>{signedRm(preview.distributedCents)} / {signedRm(preview.residualCents)}</dd>
            </div>
          </dl>
          <p className="ppx-confirm-note">生成后未发放前可撤回重做；确认发放后仍可强制扣回，代理资金冻结时需等本局或提现处理完。</p>
          <div className="ppx-stage-actions">
            <button type="button" onClick={() => setStep(3)} disabled={busy}>
              上一步
            </button>
            <button
              type="button"
              className="primary danger-confirm"
              disabled={busy}
              onClick={() => void generate()}
            >
              {busy ? '正在生成…' : '确认生成'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { del, downloadAuthorized, post, request, rm } from '../api';
import { groupByParent, visibleRows } from './batchReportTree';
import type { BatchDetail } from './types';

const STATUS: Record<string, { label: string; tone: string }> = {
  PENDING: { label: '已生成 · 待分配', tone: 'pending' },
  DISTRIBUTED: { label: '已分配', tone: 'done' },
  NO_DISTRIBUTION: { label: '无需分配', tone: 'none' },
  VOIDED: { label: '已撤回', tone: 'voided' },
};

function signedRm(cents: string) {
  const value = BigInt(cents || 0);
  return `${value < 0n ? '−' : ''}RM ${rm(value < 0n ? -value : value)}`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试';
}

export default function BatchReport({
  poolId,
  onClose,
  onChanged,
  onError,
}: {
  poolId: string;
  onClose?: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [pool, setPool] = useState<BatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  async function load() {
    setLoading(true);
    try {
      const result = await request<{ pool: BatchDetail }>(
        `/api/admin/profit-pool/batches/${poolId}`,
      );
      setPool(result.pool);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [poolId]);

  useEffect(() => {
    setExpanded(new Set());
  }, [poolId]);

  const byParent = useMemo(
    () => groupByParent(pool?.agentSnapshots ?? []),
    [pool?.agentSnapshots],
  );
  const orderedRows = useMemo(
    () => visibleRows(byParent, expanded),
    [byParent, expanded],
  );
  const rootCount = byParent.get(null)?.length ?? 0;

  function toggleAgent(sourceAgentId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sourceAgentId)) next.delete(sourceAgentId);
      else next.add(sourceAgentId);
      return next;
    });
  }

  if (loading) {
    return (
      <section className="ppx-report ppx-report-loading" aria-busy="true">
        <div className="ppx-skeleton wide" />
        <div className="ppx-skeleton-grid">
          <i />
          <i />
          <i />
          <i />
        </div>
      </section>
    );
  }
  if (!pool) return null;

  const status = STATUS[pool.status] ?? { label: pool.status, tone: 'none' };
  const exportFilename = `${pool.poolCode}.csv`;
  const remainingPointsHundredths =
    BigInt(pool.netPoolCents) > 0n
      ? Number(
          (BigInt(pool.residualCents) * BigInt(pool.bucketBaseSnapshot) * 100n) /
            BigInt(pool.netPoolCents),
        )
      : pool.bucketBaseSnapshot * 100;
  const remainingPoints = (remainingPointsHundredths / 100).toFixed(2);
  const remainingPercent = (
    remainingPointsHundredths /
    pool.bucketBaseSnapshot
  ).toFixed(2);

  async function distribute() {
    setBusy(true);
    onError('');
    try {
      await post(`/api/admin/profit-pool/batches/${poolId}/distribute`, {});
      setConfirming(false);
      await load();
      onChanged();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    setBusy(true);
    onError('');
    try {
      await post(`/api/admin/profit-pool/batches/${poolId}/discard`, {});
      setVoiding(false);
      onChanged();
      onClose?.();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    onError('');
    try {
      await del(`/api/admin/profit-pool/batches/${poolId}`);
      setDeleting(false);
      onChanged();
      onClose?.();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportReport() {
    onError('');
    try {
      await downloadAuthorized(
        `/api/admin/profit-pool/batches/${poolId}/export.csv`,
        exportFilename,
      );
    } catch (error) {
      onError(errorText(error));
    }
  }

  return (
    <section className="ppx-report">
      <header className="ppx-report-head">
        <div>
          <span className="ppx-report-kicker">COMPANY SETTLEMENT REPORT</span>
          <div className="ppx-report-title">
            <h2>{pool.poolCode}</h2>
            <span className={`ppx-batch-status ${status.tone}`}>{status.label}</span>
          </div>
          <p>
            {pool.room.title} · 第 {pool.startSeqNo}–{pool.endSeqNo} 局 · 生成于{' '}
            {new Date(pool.generatedAt).toLocaleString('zh-MY', { hour12: false })}
          </p>
        </div>
        <div className="ppx-report-actions">
          <button
            type="button"
            onClick={() => void exportReport()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />
            </svg>
            导出报表
          </button>
          {pool.status === 'PENDING' && (
            <button type="button" className="primary" onClick={() => setConfirming(true)}>
              确认发放
            </button>
          )}
          {(pool.status === 'PENDING' || pool.status === 'NO_DISTRIBUTION') && (
            <button type="button" className="danger-confirm" onClick={() => setVoiding(true)}>
              撤回重做
            </button>
          )}
          {pool.status === 'DISTRIBUTED' && (
            <button type="button" className="danger-confirm" onClick={() => setVoiding(true)}>
              强制撤回
            </button>
          )}
          {pool.status === 'VOIDED' && (
            <button type="button" className="danger-confirm" onClick={() => setDeleting(true)}>
              删除记录
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose}>
              返回列表
            </button>
          )}
        </div>
      </header>

      <div className="ppx-company-ledger">
        <article className="distributed">
          <small>代理分配合计</small>
          <strong>{signedRm(pool.distributedCents)}</strong>
          <span>全部代理称桶利润加总</span>
        </article>
        <article>
          <small>本期公司总流水</small>
          <strong>{signedRm(pool.turnoverCents)}</strong>
          <span>闲 {signedRm(pool.turnoverPlayerCents)} · 庄 {signedRm(pool.turnoverBankerCents)}</span>
        </article>
        <article>
          <small>公司总支出</small>
          <strong className="expense">−RM {rm(pool.expenseCents)}</strong>
          <span>流水 × {(pool.expenseBps / 100).toFixed(2)}%</span>
        </article>
        <article>
          <small>最终利润池</small>
          <strong>{signedRm(pool.netPoolCents)}</strong>
          <span>总抽水 {signedRm(pool.rakeTotalCents)}</span>
        </article>
        <article className="retained">
          <small>公司实际剩余占成</small>
          <strong>{remainingPoints}/{pool.bucketBaseSnapshot}</strong>
          <span>{remainingPercent}% · 以最终留存倒算</span>
        </article>
        <article className="retained-money">
          <small>剩余占成对应利润</small>
          <strong>{signedRm(pool.residualCents)}</strong>
          <span>最终利润池 − 代理分配</span>
        </article>
      </div>

      <div className="ppx-report-section-head">
        <div>
          <small>AGENT DISTRIBUTION</small>
          <h3>全部代理称桶利润</h3>
        </div>
        <span>
          默认只显示第一层 {rootCount} 位 · 合计已含整条线 · 点击展开查看各层下线利润 · 共 {pool.agentSnapshots.length} 位
        </span>
      </div>

      <div className="ppx-report-table-wrap">
        <table className="ppx-report-table">
          <thead>
            <tr>
              <th>代理 / 层级</th>
              <th>占成</th>
              <th>有效流水</th>
              <th>团队规模</th>
              <th>自身利润</th>
              <th>下级差额</th>
              <th>合计利润</th>
            </tr>
          </thead>
          <tbody>
            {orderedRows.map((row) => {
              if (row.kind === 'self') {
                return (
                  <tr key={`${row.item.id}-self`} className="ppx-level-row">
                    <td>
                      <div className="ppx-agent-cell" style={{ paddingLeft: 22 }}>
                        <span className="ppx-agent-toggle-spacer" aria-hidden="true" />
                        <span className="ppx-level-badge">本层</span>
                        <span>
                          <strong>自身利润</strong>
                          <small>{row.item.label} 本人称桶</small>
                        </span>
                      </div>
                    </td>
                    <td>
                      <b className="ppx-points">
                        {row.item.sharePointsSnapshot}/{row.item.bucketBaseSnapshot}
                      </b>
                    </td>
                    <td>
                      <strong>RM {rm(row.item.selfTurnoverCents)}</strong>
                      <small>仅自身流水</small>
                    </td>
                    <td>
                      <strong>1 代理</strong>
                      <small>本人</small>
                    </td>
                    <td>RM {rm(row.item.selfAmountCents)}</td>
                    <td>RM {rm(row.item.overrideAmountCents)}</td>
                    <td><strong className="ppx-money">RM {rm(row.item.amountCents)}</strong></td>
                  </tr>
                );
              }
              if (row.kind === 'level') {
                return (
                  <tr key={`${row.item.id}-L${row.rollup.level}`} className="ppx-level-row">
                    <td>
                      <div className="ppx-agent-cell" style={{ paddingLeft: 22 }}>
                        <span className="ppx-agent-toggle-spacer" aria-hidden="true" />
                        <span className="ppx-level-badge">L{row.rollup.level}</span>
                        <span>
                          <strong>第{row.rollup.level}层代理</strong>
                          <small>{row.rollup.count} 位下线合计</small>
                        </span>
                      </div>
                    </td>
                    <td>—</td>
                    <td>
                      <strong>RM {rm(row.rollup.selfTurnoverCents)}</strong>
                      <small>该层自身流水加总</small>
                    </td>
                    <td>
                      <strong>{row.rollup.count} 代理</strong>
                      <small>第{row.rollup.level}层</small>
                    </td>
                    <td>RM {rm(row.rollup.selfAmountCents)}</td>
                    <td>RM {rm(row.rollup.overrideAmountCents)}</td>
                    <td><strong className="ppx-money">RM {rm(row.rollup.amountCents)}</strong></td>
                  </tr>
                );
              }
              const { item, descendantCount, treeAmountCents } = row;
              const open = expanded.has(item.sourceAgentId);
              return (
                <tr
                  key={item.id}
                  className={descendantCount > 0 ? 'ppx-agent-row-expandable' : undefined}
                  onClick={descendantCount > 0 ? () => toggleAgent(item.sourceAgentId) : undefined}
                >
                  <td>
                    <div className="ppx-agent-cell">
                      {descendantCount > 0 ? (
                        <button
                          type="button"
                          className="ppx-agent-toggle"
                          aria-expanded={open}
                          aria-label={open ? `收起 ${item.label} 的各层利润` : `展开 ${item.label} 的各层利润`}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleAgent(item.sourceAgentId);
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M9 6l6 6-6 6" />
                          </svg>
                        </button>
                      ) : (
                        <span className="ppx-agent-toggle-spacer" aria-hidden="true" />
                      )}
                      <span className="ppx-mini-avatar">
                        {(item.nickname ?? item.label).slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{item.label}</strong>
                        <small>
                          L{item.level} · UID {item.uid}
                          {descendantCount > 0 ? ` · ${descendantCount} 位下线` : ''}
                        </small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <b className="ppx-points">
                      {item.sharePointsSnapshot}/{item.bucketBaseSnapshot}
                    </b>
                  </td>
                  <td>
                    <strong>RM {rm(item.teamTurnoverCents)}</strong>
                    <small>自身 RM {rm(item.selfTurnoverCents)}</small>
                  </td>
                  <td>
                    <strong>{item.teamAgentCount} 代理</strong>
                    <small>{item.teamPlayerCount} 玩家</small>
                  </td>
                  <td>RM {rm(item.selfAmountCents)}</td>
                  <td>RM {rm(item.overrideAmountCents)}</td>
                  <td>
                    <strong className="ppx-money">RM {rm(treeAmountCents)}</strong>
                    {descendantCount > 0 ? <small>含整条线</small> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {orderedRows.length === 0 && (
          <p className="ppx-empty">本期没有代理快照，利润全部由公司留存。</p>
        )}
      </div>

      <footer className="ppx-report-foot">
        <span>
          {pool.status === 'VOIDED'
            ? '已撤回，局锁已释放，可按相同局数重新生成'
            : `锁定局数：${pool.roundCount} 局（完成 ${pool.finishedRoundCount} / 取消 ${pool.cancelledRoundCount}）`}
        </span>
        <span>历史关系、占成、流水与利润均按生成时快照显示</span>
      </footer>

      {confirming && (
        <div className="ppx-modal-backdrop" role="presentation">
          <div
            className="ppx-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ppx-distribute-title"
          >
            <span className="ppx-modal-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3 2.8 20h18.4L12 3Z" />
                <path d="M12 9v5M12 17.5v.1" />
              </svg>
            </span>
            <small>IRREVERSIBLE PAYOUT</small>
            <h3 id="ppx-distribute-title">确认发放 {pool.poolCode}？</h3>
            <p>
              将向 {pool.agentSnapshots.filter((agent) => BigInt(agent.amountCents) > 0n).length}{' '}
              位代理发放合计 <b>{signedRm(pool.distributedCents)}</b>。资金会立即进入代理可用余额，不能撤销。
            </p>
            <div>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void distribute()}
              >
                {busy ? '正在发放…' : '确认并立即发放'}
              </button>
            </div>
          </div>
        </div>
      )}

      {voiding && (
        <div className="ppx-modal-backdrop" role="presentation">
          <div
            className="ppx-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ppx-void-title"
          >
            <span className="ppx-modal-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3 2.8 20h18.4L12 3Z" />
                <path d="M12 9v5M12 17.5v.1" />
              </svg>
            </span>
            <small>{pool.status === 'DISTRIBUTED' ? 'FORCE CLAWBACK' : 'RELEASE ROUND LOCKS'}</small>
            <h3 id="ppx-void-title">
              {pool.status === 'DISTRIBUTED' ? `强制撤回 ${pool.poolCode}？` : `撤回 ${pool.poolCode}？`}
            </h3>
            <p>
              {pool.status === 'DISTRIBUTED'
                ? `将从代理可用余额扣回已发放的 ${signedRm(pool.distributedCents)}，并释放第 ${pool.startSeqNo}–${pool.endSeqNo} 局。若有代理余额不足，整笔撤回会失败、不会部分扣款。`
                : `将释放第 ${pool.startSeqNo}–${pool.endSeqNo} 局的局锁，之后可以重新生成。资金尚未入账，代理余额不会变动。`}
            </p>
            <div>
              <button type="button" disabled={busy} onClick={() => setVoiding(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary danger-confirm"
                disabled={busy}
                onClick={() => void discard()}
              >
                {busy
                  ? '正在撤回…'
                  : pool.status === 'DISTRIBUTED'
                    ? '确认强制撤回并扣回资金'
                    : '确认撤回并释放局锁'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleting && (
        <div className="ppx-modal-backdrop" role="presentation">
          <div
            className="ppx-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ppx-delete-title"
          >
            <span className="ppx-modal-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3 2.8 20h18.4L12 3Z" />
                <path d="M12 9v5M12 17.5v.1" />
              </svg>
            </span>
            <small>PERMANENT DELETE</small>
            <h3 id="ppx-delete-title">删除 {pool.poolCode}？</h3>
            <p>
              将永久删除该已撤回利润池的报表快照。局锁已在撤回时释放，代理余额不会再变动。此操作不可恢复。
            </p>
            <div>
              <button type="button" disabled={busy} onClick={() => setDeleting(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary danger-confirm"
                disabled={busy}
                onClick={() => void remove()}
              >
                {busy ? '正在删除…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

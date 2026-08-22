import { useState } from 'react';
import { post } from './api';

export const CUSTOMER_PURGE_CONFIRM_TEXT = '确认删除';

export default function PurgeCustomerBox({
  userId,
  uid,
  nickname,
  busy,
  onBusy,
  onError,
  onPurged,
}: {
  userId: string;
  uid: string;
  nickname?: string | null;
  busy: boolean;
  onBusy: (value: boolean) => void;
  onError: (message: string) => void;
  onPurged: (uid: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmUid, setConfirmUid] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');

  function close() {
    if (busy) return;
    setOpen(false);
    setStep(1);
    setConfirmUid('');
    setConfirmText('');
    setReason('');
  }

  async function submit() {
    if (confirmUid.trim() !== uid || confirmText.trim() !== CUSTOMER_PURGE_CONFIRM_TEXT) {
      onError(`请输入 UID ${uid}，并原样填写「${CUSTOMER_PURGE_CONFIRM_TEXT}」`);
      return;
    }
    if (reason.trim().length < 4) {
      onError('删除原因至少 4 个字');
      return;
    }
    onBusy(true);
    onError('');
    try {
      const result = await post<{ ok: true; uid: string }>(`/api/admin/users/${userId}/purge`, {
        confirmUid: confirmUid.trim(),
        confirmText: confirmText.trim(),
        reason: reason.trim(),
      });
      onPurged(result.uid);
    } catch (error) {
      onError(error instanceof Error ? error.message : '删除失败');
    } finally {
      onBusy(false);
    }
  }

  const ready =
    confirmUid.trim() === uid &&
    confirmText.trim() === CUSTOMER_PURGE_CONFIRM_TEXT &&
    reason.trim().length >= 4;

  return (
    <section className="user-purge-box">
      <div>
        <small>不可恢复</small>
        <h3>删除该客户的全部数据</h3>
        <p>
          将清除账号、实名、设备、钱包、流水、充提、邀请关系、房间成员与该客户自己的下注/抢包记录。
          仍有可用余额、冻结资金、未领完群红包或待审充提时不能删。
          已生成的称桶快照和已发布成绩单不会改写。虚拟玩家、代理、游戏管理员账号不能从这里删。
        </p>
      </div>
      <button
        type="button"
        className="user-purge-open"
        disabled={busy}
        onClick={() => {
          onError('');
          setOpen(true);
          setStep(1);
        }}
      >
        删除全部数据
      </button>

      {open && (
        <div className="user-purge-overlay" role="dialog" aria-modal="true" aria-labelledby="user-purge-title">
          <div className="user-purge-dialog">
            {step === 1 ? (
              <>
                <small>第一次确认</small>
                <h3 id="user-purge-title">确定要删除这位客户吗？</h3>
                <p>
                  {nickname || '未设置昵称'} · UID {uid}
                  <br />
                  删除后无法恢复登录，Telegram 需要重新注册才会变成新客户。请确认不是点错人。
                </p>
                <div className="user-purge-actions">
                  <button type="button" onClick={close} disabled={busy}>
                    取消
                  </button>
                  <button type="button" className="user-purge-continue" onClick={() => setStep(2)}>
                    我已核对身份，继续
                  </button>
                </div>
              </>
            ) : (
              <>
                <small>第二次确认</small>
                <h3 id="user-purge-title">请输入 UID 和确认词</h3>
                <p>
                  必须同时输入 UID <strong>{uid}</strong>，以及确认词
                  「{CUSTOMER_PURGE_CONFIRM_TEXT}」，并填写原因后才会提交。
                </p>
                <label>
                  客户 UID
                  <input
                    value={confirmUid}
                    autoComplete="off"
                    placeholder={uid}
                    disabled={busy}
                    onChange={(event) => setConfirmUid(event.target.value)}
                  />
                </label>
                <label>
                  确认词
                  <input
                    value={confirmText}
                    autoComplete="off"
                    placeholder={CUSTOMER_PURGE_CONFIRM_TEXT}
                    disabled={busy}
                    onChange={(event) => setConfirmText(event.target.value)}
                  />
                </label>
                <label>
                  删除原因
                  <textarea
                    value={reason}
                    rows={3}
                    placeholder="至少 4 个字，写入审计日志"
                    disabled={busy}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                <div className="user-purge-actions">
                  <button type="button" onClick={() => setStep(1)} disabled={busy}>
                    上一步
                  </button>
                  <button
                    type="button"
                    className="user-purge-submit"
                    disabled={busy || !ready}
                    onClick={() => void submit()}
                  >
                    {busy ? '正在删除…' : '永久删除'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import {
  IconBank,
  IconChevronRight,
  IconDevice,
  IconDocument,
  IconIdCard,
  IconInfo,
  IconShield,
  IconSupport,
} from '../components/Icons';
import type { Session } from '../sessionStore';

const kycLabel: Record<string, string> = {
  APPROVED: '已通过',
  PENDING: '审核中',
  REJECTED: '已驳回',
  NONE: '未提交',
};

export default function Settings({ session }: { session: Session }) {
  const navigate = useNavigate();
  const [security, setSecurity] = useState<Awaited<
    ReturnType<typeof api.securitySettings>
  > | null>(null);
  const [accountCount, setAccountCount] = useState<number | null>(null);
  const paymentPinSet = security?.paymentPin.set ?? session.security.paymentPinSet;
  const lockedUntil =
    security?.paymentPin.lockedUntil ?? session.security.paymentPinLockedUntil;
  const locked = Boolean(lockedUntil && new Date(lockedUntil) > new Date());
  const kycStatus = security?.kycStatus ?? session.onboarding.kycStatus;

  useEffect(() => {
    api.securitySettings().then(setSecurity).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (kycStatus !== 'APPROVED') {
      setAccountCount(null);
      return;
    }
    api
      .withdrawAccounts()
      .then((result) => setAccountCount(result.items.length))
      .catch(() => setAccountCount(null));
  }, [kycStatus]);

  return (
    <div className="page subpage settings-page">
      <header className="subpage-header">
        <button type="button" onClick={() => navigate('/')} aria-label="返回">‹</button>
        <div><h1>设置</h1></div>
        <span />
      </header>

      <section className={`settings-security-card ${paymentPinSet ? 'secured' : 'attention'}`}>
        <div className="settings-security-mark">
          <IconShield size={24} />
        </div>
        <div>
          <small>账户安全状态</small>
          <h2>
            {locked
              ? '支付密码暂时锁定'
              : paymentPinSet
                ? '资金保护已开启'
                : '请完成支付密码设置'}
          </h2>
          <p>
            {locked
              ? '连续输入错误触发安全锁定，请稍后再试。'
              : paymentPinSet
                ? '提现和发送群红包均需进行支付验证。'
                : '实名认证已通过后，必须设置支付密码才能转出资金。'}
          </p>
        </div>
      </section>

      <section className="settings-group">
        <h3>账户安全</h3>
        <div className="settings-list">
          <button type="button" onClick={() => navigate('/kyc')}>
            <span className="settings-row-icon"><IconIdCard size={19} /></span>
            <span className="settings-row-copy">
              <strong>实名认证</strong>
              <small>姓名与 DuitNow 身份核验</small>
            </span>
            <em className={kycStatus === 'APPROVED' ? 'ok' : kycStatus === 'REJECTED' ? 'danger' : 'warn'}>
              {kycLabel[kycStatus] ?? kycStatus}
            </em>
            <IconChevronRight size={17} />
          </button>
          <button
            type="button"
            onClick={() =>
              kycStatus === 'APPROVED' || kycStatus === 'PENDING'
                ? navigate('/settings/banks', { state: { returnTo: '/settings' } })
                : navigate('/kyc')
            }
          >
            <span className="settings-row-icon"><IconBank size={19} /></span>
            <span className="settings-row-copy">
              <strong>提现账户</strong>
              <small>添加银行或电子钱包账号</small>
            </span>
            <em>
              {kycStatus !== 'APPROVED'
                ? '需实名'
                : accountCount == null
                  ? '管理'
                  : accountCount > 0
                    ? `${accountCount} 个`
                    : '待添加'}
            </em>
            <IconChevronRight size={17} />
          </button>
          <button type="button" onClick={() => navigate('/settings/payment-pin')}>
            <span className="settings-row-icon gold"><IconShield size={19} /></span>
            <span className="settings-row-copy">
              <strong>支付密码</strong>
              <small>保护提现与群红包</small>
            </span>
            <em className={locked ? 'danger' : paymentPinSet ? 'ok' : 'warn'}>
              {locked ? '已锁定' : paymentPinSet ? '已设置' : '待设置'}
            </em>
            <IconChevronRight size={17} />
          </button>
          <button type="button" onClick={() => navigate('/settings/device')}>
            <span className="settings-row-icon"><IconDevice size={19} /></span>
            <span className="settings-row-copy">
              <strong>设备管理</strong>
              <small>查看当前绑定设备</small>
            </span>
            <em>{security?.device?.status === 'ACTIVE' ? '已绑定' : '查看'}</em>
            <IconChevronRight size={17} />
          </button>
        </div>
      </section>

      <section className="settings-group">
        <h3>服务与支持</h3>
        <div className="settings-list">
          <button type="button" onClick={() => navigate('/support')}>
            <span className="settings-row-icon"><IconSupport size={19} /></span>
            <span className="settings-row-copy">
              <strong>在线客服</strong>
              <small>账户、设备与资金协助</small>
            </span>
            <IconChevronRight size={17} />
          </button>
        </div>
      </section>

      <section className="settings-group">
        <h3>协议与关于</h3>
        <div className="settings-list">
          <button type="button" onClick={() => navigate('/settings/legal')}>
            <span className="settings-row-icon"><IconDocument size={19} /></span>
            <span className="settings-row-copy">
              <strong>协议与隐私</strong>
              <small>用户协议、隐私政策及资金规则</small>
            </span>
            <IconChevronRight size={17} />
          </button>
          <div className="settings-static-row">
            <span className="settings-row-icon"><IconInfo size={19} /></span>
            <span className="settings-row-copy">
              <strong>关于至尊牛牛</strong>
              <small>安全、透明的互动体验</small>
            </span>
            <em>v{import.meta.env.VITE_APP_VERSION ?? '1.0.0'}</em>
          </div>
        </div>
      </section>

      <p className="settings-footer-id">UID {session.uid}</p>
    </div>
  );
}

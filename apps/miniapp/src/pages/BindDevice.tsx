import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { getDeviceId } from '../telegram';
import { LegalLinks } from './LegalDoc';

export default function BindDevice({ onDone }: { onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  async function handleBind() {
    setBusy(true);
    setError('');
    try {
      await api.bindDevice(getDeviceId());
      await onDone();
      // 设备绑定完成即注册完成，直接进入大厅；实名由钱包入口后置触发。
      navigate('/', { replace: true });
    } catch (e) {
      const code = (e as Error & { code?: string }).code;
      setError(code === 'DEVICE_MISMATCH' ? '该账号已绑定其他设备，请通过原设备联系客服更换' : '绑定失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="center" style={{ padding: '40px 0 24px' }}>
        <div style={{ fontSize: 56 }}>🔐</div>
        <div className="page-title">新设备登录</div>
        <p className="muted" style={{ lineHeight: 1.7 }}>
          为保障您的账号资产安全，本平台对每个账号实行单设备绑定机制。请确认在常用设备完成绑定。
        </p>
      </div>

      <div className="card">
        <div className="rate-row">👤 一账号一设备，绑定后不可自行更换</div>
        <div className="rate-row">🎧 后续如需更换绑定设备，需通过原绑定设备小程序内联系客服协助更换</div>
        <div className="rate-row">💳 请确认本设备已安装并登录 Touch 'n Go，否则将影响充值、提现及游戏功能的正常使用</div>
      </div>

      {error && <div className="error">{error}</div>}

      <button className="btn" disabled={busy} onClick={handleBind}>
        绑定本设备
      </button>
      <p className="muted center legal-consent">
        点击「绑定本设备」即表示您已阅读并同意
        <LegalLinks />
        。
      </p>
    </div>
  );
}

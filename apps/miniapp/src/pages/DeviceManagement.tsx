import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconDevice, IconShield, IconSupport } from '../components/Icons';
import { goBack } from '../lib/nav';

type DeviceResult = Awaited<ReturnType<typeof api.deviceSettings>>;

export default function DeviceManagement() {
  const navigate = useNavigate();
  const location = useLocation();
  const [result, setResult] = useState<DeviceResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .deviceSettings()
      .then(setResult)
      .catch((reason) => setError((reason as Error).message || '设备信息加载失败'));
  }, []);

  const device = result?.device;
  return (
    <div className="page subpage device-page">
      <header className="subpage-header">
        <button type="button" onClick={() => goBack(navigate, location, '/settings')} aria-label="返回">‹</button>
        <div><h1>设备管理</h1></div>
        <span />
      </header>

      <section className="device-hero">
        <span><IconDevice size={28} /></span>
        <small>CURRENT DEVICE</small>
        <h2>{device?.status === 'ACTIVE' ? '当前设备已安全绑定' : '等待绑定设备'}</h2>
        <p>一个账号同时只能绑定一台设备，用于降低账号被盗和异地操作风险。</p>
      </section>

      {error && <div className="inline-alert error">{error}</div>}

      <section className="device-card">
        <div className="device-card-head">
          <span><IconShield size={20} /></span>
          <div>
            <strong>Telegram Mini App</strong>
            <small>{device?.status === 'ACTIVE' ? '本机 · 正常使用中' : '未绑定'}</small>
          </div>
          <em className={device?.status === 'ACTIVE' ? 'active' : ''}>
            {device?.status === 'ACTIVE' ? '当前设备' : '未绑定'}
          </em>
        </div>
        <dl>
          <div><dt>设备标识</dt><dd>{device?.maskedId ?? '—'}</dd></div>
          <div>
            <dt>绑定时间</dt>
            <dd>{device?.boundAt ? new Date(device.boundAt).toLocaleString('zh-MY') : '—'}</dd>
          </div>
          <div><dt>绑定规则</dt><dd>一账号一设备</dd></div>
        </dl>
      </section>

      <section className="device-security-tips">
        <h3>设备安全建议</h3>
        <p><i>1</i><span>不要将 Telegram 登录或本机解锁信息提供给他人。</span></p>
        <p><i>2</i><span>更换手机、设备遗失或发现异常操作时，请立即联系客服。</span></p>
        <p><i>3</i><span>设备解绑或支付密码重置后，旧会话将失效并需要重新绑定。</span></p>
      </section>

      <button
        type="button"
        className="device-support-button"
        onClick={() => navigate('/support')}
      >
        <IconSupport size={19} />
        更换或解绑设备
      </button>
      <p className="device-support-note">为保护账户资金，设备变更需要客服核验身份。</p>
    </div>
  );
}

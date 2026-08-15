import { useLocation, useNavigate } from 'react-router-dom';
import { IconChevronRight, IconDocument, IconShield } from '../components/Icons';
import { legalDocs, type LegalDocKey } from '../legal';
import { goBack } from '../lib/nav';

const items: Array<{
  key: LegalDocKey;
  description: string;
  important?: boolean;
}> = [
  { key: 'terms', description: '账号使用、服务规则与双方权利义务' },
  { key: 'privacy', description: '个人资料的收集、使用、保存与权利' },
  { key: 'security', description: '支付密码、设备绑定与风险处置', important: true },
  { key: 'funds', description: '充值、提现、手续费与资金审核规则' },
  { key: 'responsible', description: '理性参与、风险认识与自我保护' },
];

export default function LegalCenter() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div className="page subpage legal-center-page">
      <header className="subpage-header">
        <button type="button" onClick={() => goBack(navigate, location, '/settings')} aria-label="返回">‹</button>
        <div><h1>协议与隐私</h1></div>
        <span />
      </header>

      <section className="legal-center-hero">
        <span><IconShield size={24} /></span>
        <div>
          <small>TRANSPARENCY CENTER</small>
          <h2>了解您的权利与资金规则</h2>
          <p>请在使用服务和进行资金操作前认真阅读以下文件。</p>
        </div>
      </section>

      <section className="legal-center-list">
        {items.map((item) => (
          <button
            type="button"
            key={item.key}
            onClick={() => navigate(`/legal/${item.key}`)}
          >
            <span className={`legal-center-icon ${item.important ? 'important' : ''}`}>
              {item.important ? <IconShield size={19} /> : <IconDocument size={19} />}
            </span>
            <span>
              <strong>{legalDocs[item.key].title}</strong>
              <small>{item.description}</small>
            </span>
            <em>{legalDocs[item.key].updatedAt}</em>
            <IconChevronRight size={17} />
          </button>
        ))}
      </section>

      <p className="legal-center-note">
        如对条款、个人资料或资金规则有疑问，请在操作前联系在线客服。
      </p>
    </div>
  );
}

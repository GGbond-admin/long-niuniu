import { Link, useNavigate, useParams } from 'react-router-dom';
import { legalDocs, type LegalDocKey } from '../legal';

function isLegalKey(value: string | undefined): value is LegalDocKey {
  return (
    value === 'terms' ||
    value === 'privacy' ||
    value === 'security' ||
    value === 'funds' ||
    value === 'responsible'
  );
}

export default function LegalDoc() {
  const { type } = useParams();
  const navigate = useNavigate();
  const key: LegalDocKey = isLegalKey(type) ? type : 'terms';
  const doc = legalDocs[key];
  const related = (Object.keys(legalDocs) as LegalDocKey[]).filter((item) => item !== key);

  return (
    <div className="page subpage legal-page">
      <header className="subpage-header">
        <button type="button" onClick={() => navigate(-1)} aria-label="返回">
          ‹
        </button>
        <div>
          <h1>{doc.title}</h1>
        </div>
        <span />
      </header>

      <p className="legal-updated">更新日期：{doc.updatedAt}</p>

      <article className="legal-article">
        {doc.sections.map((section) => (
          <section key={section.heading} className="legal-section">
            <h2>{section.heading}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph.slice(0, 24)}>{paragraph}</p>
            ))}
          </section>
        ))}
      </article>

      <div className="legal-switch">
        <span>相关文件</span>
        <div>
          {related.map((item) => (
            <Link key={item} to={`/legal/${item}`}>{legalDocs[item].title}</Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 协议勾选文案里的可点击链接 */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <span className={className}>
      <Link className="legal-inline-link" to="/legal/terms" onClick={(e) => e.stopPropagation()}>
        《用户协议》
      </Link>
      与
      <Link className="legal-inline-link" to="/legal/privacy" onClick={(e) => e.stopPropagation()}>
        《隐私政策》
      </Link>
    </span>
  );
}

import { useState } from 'react';
import { resolveInstitutionMeta } from '../data/institutions';

/** 真实机构 LOGO（/public/institutions/*.svg，来源 Payment-Icon 开源图标集） */
export default function InstitutionLogo({
  name,
  size = 40,
}: {
  name: string;
  size?: number;
}) {
  const meta = resolveInstitutionMeta(name);
  const [failed, setFailed] = useState(false);
  const fontSize = meta.short.length > 3 ? size * 0.28 : size * 0.34;
  const showImage = Boolean(meta.logo) && !failed;

  return (
    <span
      className={`institution-logo ${showImage ? 'has-image' : ''} institution-logo-${meta.code}`}
      style={{
        width: size,
        height: size,
        background: showImage ? '#ffffff' : meta.color,
        color: meta.textColor ?? '#ffffff',
        fontSize,
      }}
      aria-hidden
      title={name}
    >
      {showImage ? (
        <img
          src={meta.logo}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <strong>{meta.short}</strong>
      )}
    </span>
  );
}

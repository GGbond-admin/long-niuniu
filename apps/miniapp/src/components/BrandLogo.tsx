const LOGO_SRC = '/logo.png';

type BrandLogoProps = {
  size?: number;
  className?: string;
  alt?: string;
};

export default function BrandLogo({ size = 40, className, alt = '至尊牛牛' }: BrandLogoProps) {
  return (
    <img
      src={LOGO_SRC}
      alt={alt}
      width={size}
      height={size}
      className={className ? `brand-logo ${className}` : 'brand-logo'}
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

export { LOGO_SRC };

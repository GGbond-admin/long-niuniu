export default function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {subtitle && <p className="page-header-sub">{subtitle}</p>}
        <h1 className="page-header-title">{title}</h1>
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </header>
  );
}

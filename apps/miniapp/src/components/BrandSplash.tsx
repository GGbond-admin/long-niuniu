type BrandSplashProps = {
  hint?: string;
};

/** Telegram 进厅与登录校验期间的品牌加载，与 index.html 启动画面保持一致。 */
export default function BrandSplash({ hint = '正在进入…' }: BrandSplashProps) {
  return (
    <div className="boot-splash" role="status" aria-live="polite">
      <strong>至尊牛牛</strong>
      <span>{hint}</span>
      <i className="boot-splash-bar" aria-hidden="true" />
    </div>
  );
}

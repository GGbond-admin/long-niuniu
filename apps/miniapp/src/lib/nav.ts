import type { Location, NavigateFunction } from 'react-router-dom';

/**
 * 真实返回：有上一页历史时回退（不再 push 新纪录，避免历史栈越叠越深、
 * 系统返回键要一层层重放）；深链直达无历史时回落到 fallback，
 * 防止 navigate(-1) 直接退出小程序。
 */
export function goBack(
  navigate: NavigateFunction,
  location: Location,
  fallback = '/',
) {
  if (location.key !== 'default') navigate(-1);
  else navigate(fallback, { replace: true });
}

type TabKey = 'lobby' | 'wallet' | 'chat' | 'me';

/**
 * 返回主界面指定 Tab：有历史时按真实回退（Tab 状态由 sessionStorage 保持）；
 * 深链直达时写入目标 Tab 后回主页。
 */
export function backToTab(
  navigate: NavigateFunction,
  location: Location,
  tab: TabKey,
) {
  if (location.key !== 'default') {
    navigate(-1);
    return;
  }
  try {
    sessionStorage.setItem('miniapp-tab', tab);
  } catch {
    // ignore storage errors
  }
  navigate('/', { replace: true });
}

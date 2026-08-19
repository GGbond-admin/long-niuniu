import { useLayoutEffect, useRef } from 'react';

/**
 * Full-page features opened from an internally scrolling screen must not inherit
 * the document's old scroll offset. Reset before paint and keep scrolling on the
 * feature container so async content cannot move the whole WebView.
 */
export function useIsolatedPageScroll<T extends HTMLElement>() {
  const scrollRef = useRef<T>(null);

  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, []);

  return scrollRef;
}

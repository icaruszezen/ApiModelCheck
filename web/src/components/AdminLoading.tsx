import { Spinner } from "@endfield-ui/react";
import { useEffect, useState } from "react";
import { createLoadingTimeline, fadeDelay } from "./loading-timeline";

// 整个页面只有一串后台载入提示，放在模块里记着
const timeline = createLoadingTimeline();

/**
 * 进后台时的载入提示：App.tsx 等后台代码、AdminApp 确认登录状态都用它，看上去是同一段载入。
 * 通常一下就载完：先空着，过 300ms 还没好才淡入；前一段已经显示出来时，后一段接着显示，不再闪一下。
 * 放在主包里（不在后台的包里），Suspense 的 fallback 才用得上
 */
export function AdminLoading() {
  const [delay] = useState(() => {
    const now = performance.now();
    return fadeDelay(timeline.begin(now), now);
  });
  useEffect(() => {
    timeline.mounted();
    return () => timeline.unmounted(performance.now());
  }, []);
  return (
    <div
      role="status"
      style={{ transitionDelay: `${Math.round(delay)}ms` }}
      className="flex min-h-dvh items-center justify-center gap-2 bg-surface text-sm text-ink-secondary transition-opacity duration-(--duration-base) starting:opacity-0"
    >
      <Spinner label={null} />
      正在载入后台
    </div>
  );
}

/**
 * 进后台时有两段载入：先等后台的代码（App.tsx 的 Suspense），再确认登录状态（AdminApp）。
 * 两段用同一个提示组件，这里记着"这一串提示是什么时候出现的"，让后一段接着前一段走：
 * 前一段还在屏幕上（或者刚换下来）时，后一段沿用它出现的时刻，不再从头空 300ms、重新淡入，
 * 否则慢网速下会先淡入、消失、再淡入，闪一下。纯逻辑，方便测。
 */

/** 先空着多久才淡入（毫秒）：通常一下就载完，免得一闪 */
export const FADE_DELAY_MS = 300;

/** 前一个提示换下后这么短时间内出现的，算同一串（两段之间 React 换组件只要几毫秒） */
export const CONTINUE_WITHIN_MS = 100;

export interface LoadingTimeline {
  /** 一个提示要显示了（渲染时调）：返回这一串提示最早出现的时刻 */
  begin(now: number): number;
  /** 提示挂上 / 卸下时调 */
  mounted(): void;
  unmounted(now: number): void;
}

export function createLoadingTimeline(): LoadingTimeline {
  let visible = 0;
  let shownAt = 0;
  let hiddenAt = Number.NEGATIVE_INFINITY;
  return {
    begin(now) {
      if (visible === 0 && now - hiddenAt > CONTINUE_WITHIN_MS) shownAt = now;
      return shownAt;
    },
    mounted() {
      visible += 1;
    },
    unmounted(now) {
      visible = Math.max(0, visible - 1);
      if (visible === 0) hiddenAt = now;
    },
  };
}

/**
 * 淡入还要等多久开始（毫秒），直接当 transition-delay 用。
 * 负数表示淡入已经走了一段：CSS 过渡会从那里接着走；早就走完时浏览器不再过渡，直接显示
 */
export function fadeDelay(shownAt: number, now: number): number {
  return FADE_DELAY_MS - (now - shownAt);
}

import { describe, expect, it } from "vitest";
import {
  CONTINUE_WITHIN_MS,
  createLoadingTimeline,
  FADE_DELAY_MS,
  fadeDelay,
} from "./loading-timeline";

describe("createLoadingTimeline", () => {
  it("第一次出现：从现在算起", () => {
    const timeline = createLoadingTimeline();
    expect(timeline.begin(1000)).toBe(1000);
  });

  it("前一段还在屏幕上时出现的：沿用前一段出现的时刻", () => {
    const timeline = createLoadingTimeline();
    timeline.begin(1000);
    timeline.mounted();
    // 后台代码载完，AdminApp 渲染确认登录状态的提示，这时 Suspense 的那个还挂着
    expect(timeline.begin(1800)).toBe(1000);
    timeline.unmounted(1801);
    timeline.mounted();
    timeline.unmounted(2600);
  });

  it("前一段刚换下就出现的（React 先卸后挂）也算同一串", () => {
    const timeline = createLoadingTimeline();
    timeline.begin(1000);
    timeline.mounted();
    timeline.unmounted(1800);
    expect(timeline.begin(1800 + CONTINUE_WITHIN_MS)).toBe(1000);
  });

  it("隔了一阵再出现的（比如点重试、从前台再进后台）重新算", () => {
    const timeline = createLoadingTimeline();
    timeline.begin(1000);
    timeline.mounted();
    timeline.unmounted(1800);
    expect(timeline.begin(1800 + CONTINUE_WITHIN_MS + 1)).toBe(
      1800 + CONTINUE_WITHIN_MS + 1,
    );
  });

  it("开发模式下 StrictMode 挂两次也不乱", () => {
    const timeline = createLoadingTimeline();
    timeline.begin(1000);
    timeline.mounted();
    timeline.unmounted(1001);
    timeline.mounted();
    expect(timeline.begin(5000)).toBe(1000);
  });
});

describe("fadeDelay", () => {
  it("刚出现：等满再淡入", () => {
    expect(fadeDelay(1000, 1000)).toBe(FADE_DELAY_MS);
  });

  it("前一段已经等了一会儿：只等剩下的", () => {
    expect(fadeDelay(1000, 1100)).toBe(FADE_DELAY_MS - 100);
  });

  it("前一段已经开始淡入：负数，让过渡从那里接着走", () => {
    expect(fadeDelay(1000, 1000 + FADE_DELAY_MS + 120)).toBe(-120);
  });
});

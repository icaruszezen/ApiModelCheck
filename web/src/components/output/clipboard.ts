/**
 * 复制文字到剪贴板。用 http 直接访问（没有 https、不是 localhost）时浏览器不给 Clipboard API，
 * 退回到"选中一个隐藏的文本框再执行复制"的老办法。
 */
export async function copyText(text: string, host?: HTMLElement | null): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 权限被拒等情况：走下面的兜底
    }
  }

  // 文本框放在按钮旁边而不是 <body> 下：弹窗打开时焦点被限制在弹窗里，放到外面选不中
  const container = host ?? document.body;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
  container.appendChild(area);
  let copied = false;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    copied = document.execCommand("copy");
  } finally {
    area.remove();
    previousFocus?.focus({ preventScroll: true });
  }
  if (!copied) throw new Error("浏览器不允许复制");
}

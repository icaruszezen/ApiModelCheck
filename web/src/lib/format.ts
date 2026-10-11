/** 时间、时长、数字的显示格式。时间按浏览器的时区显示。 */

const pad = (value: number) => String(value).padStart(2, "0");

/** "2026-10-11 16:27:05" */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 今年的省掉年份："10-11 16:27" */
export function formatShortDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameYear ? day : `${date.getFullYear()}-${day}`;
}

/** 1234 → "1.2 秒"，65000 → "1 分 5 秒" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** 检测间隔：90 → "1 小时 30 分钟"，1440 → "1 天" */
export function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return [
    days ? `${days} 天` : "",
    hours ? `${hours} 小时` : "",
    mins ? `${mins} 分钟` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** 相对现在的时间："3 分钟前"、"12 分钟后"、"刚刚" */
export function formatRelative(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "—";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "—";
  const diff = time - now;
  const abs = Math.abs(diff);
  const suffix = diff < 0 ? "前" : "后";
  if (abs < 45_000) return diff < 0 ? "刚刚" : "即将";
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return `${minutes} 分钟${suffix}`;
  const hours = Math.round(abs / 3_600_000);
  if (hours < 48) return `${hours} 小时${suffix}`;
  return `${Math.round(abs / 86_400_000)} 天${suffix}`;
}

/** 12345 → "12,345"；null → "—" */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("zh-CN");
}

/**
 * 读取环境变量，得到服务运行需要的配置。
 * 只有 resolveSessionSecret 会碰文件系统，其余都是纯函数，方便测试。
 */
import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录（server/ 的上一层），不依赖启动时的工作目录 */
export const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export interface EnvConfig {
  port: number;
  host: string;
  /** 绝对路径 */
  dataDir: string;
  adminUsername: string;
  /** 没设 ADMIN_PASSWORD 时为 null，由调用方生成临时密码 */
  adminPassword: string | null;
  /** 没设 SESSION_SECRET 时为 null，由调用方从数据目录读取或生成 */
  sessionSecret: string | null;
  /** 信任的反向代理层数，0 表示不信任（见 parseTrustProxy） */
  trustProxy: number;
  schedulerTickSeconds: number;
}

/** 认证与请求处理需要的那部分配置（createApp 用） */
export interface AuthConfig {
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  /** 信任的反向代理层数，0 表示不信任；true / false 等同 1 / 0 */
  trustProxy: number | boolean;
}

/** AuthConfig.trustProxy 统一成层数 */
export function proxyHops(trustProxy: number | boolean): number {
  if (typeof trustProxy === "boolean") return trustProxy ? 1 : 0;
  return Math.max(0, Math.floor(trustProxy));
}

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseIntEnv(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `环境变量 ${name} 必须是 ${min} 到 ${max} 之间的整数，现在是 "${raw}"`,
    );
  }
  return value;
}

const MAX_PROXY_HOPS = 10;

/**
 * TRUST_PROXY 是信任的反向代理层数：不设、0、false、no、off 为不信任；true、yes、on 等同 1；
 * 也可以直接写层数（2 = CDN 后面再套一层 Nginx 之类）。决定 X-Forwarded-For 从右往左取第几个。
 */
function parseTrustProxy(env: Env): number {
  const raw = nonEmpty(env.TRUST_PROXY)?.toLowerCase();
  if (raw === undefined) return 0;
  if (raw === "false" || raw === "no" || raw === "off") return 0;
  if (raw === "true" || raw === "yes" || raw === "on") return 1;
  const value = Number(raw);
  if (/^\d+$/.test(raw) && value <= MAX_PROXY_HOPS) return value;
  throw new Error(
    `环境变量 TRUST_PROXY 必须是 0 到 ${MAX_PROXY_HOPS} 之间的代理层数（或 true / false），现在是 "${raw}"`,
  );
}

export function readEnvConfig(env: Env = process.env): EnvConfig {
  const dataDir = nonEmpty(env.DATA_DIR);
  return {
    port: parseIntEnv(env, "PORT", 3000, 0, 65535),
    host: nonEmpty(env.HOST) ?? "0.0.0.0",
    // 显式设置的相对路径按工作目录解析；默认值放在项目根目录下，从哪里启动都是同一个库
    dataDir: dataDir ? resolve(dataDir) : join(PROJECT_ROOT, "data"),
    adminUsername: nonEmpty(env.ADMIN_USERNAME) ?? "admin",
    // 密码不去空白：首尾空格也可能是密码的一部分
    adminPassword: env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD : null,
    sessionSecret: env.SESSION_SECRET ? env.SESSION_SECRET : null,
    trustProxy: parseTrustProxy(env),
    schedulerTickSeconds: parseIntEnv(
      env,
      "SCHEDULER_TICK_SECONDS",
      15,
      1,
      3600,
    ),
  };
}

const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** 生成一个 16 位的随机密码（去掉了 0/O、1/l/I 这类容易看错的字符） */
export function generatePassword(length = 16): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

const MIN_PASSWORD_LENGTH = 8;

/** 示例、文档里出现过的占位密码和最常见的弱密码（比较时不分大小写） */
const PLACEHOLDER_PASSWORDS = new Set([
  "change-me",
  "changeme",
  "password",
  "admin",
  "123456",
  "12345678",
  "你自己的密码",
  "换成你自己的密码",
  "你的密码",
]);

/** 去掉首尾空白和一层成对的引号（compose 列表写法等会把引号原样传进来） */
function normalizePassword(password: string): string {
  const trimmed = password.trim();
  const quoted = /^(["'])(.*)\1$/s.exec(trimmed);
  return (quoted ? (quoted[2] ?? "").trim() : trimmed).toLowerCase();
}

/**
 * 设置了的 ADMIN_PASSWORD 太弱（示例 / 文档里的占位密码、常见弱密码，或少于 8 个字符）时返回提醒，
 * 否则 null。只提醒、不拦着启动。
 */
export function weakPasswordWarning(password: string | null): string | null {
  if (password === null) return null;
  if (PLACEHOLDER_PASSWORDS.has(normalizePassword(password))) {
    return "ADMIN_PASSWORD 还是示例或文档里的占位密码（如 change-me）或常见弱密码，谁都能登录后台，请马上换成你自己的密码";
  }
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) {
    return `ADMIN_PASSWORD 只有 ${length} 个字符，很容易被猜中，请换成至少 ${MIN_PASSWORD_LENGTH} 个字符的密码`;
  }
  return null;
}

/**
 * 会话密钥：优先用环境变量；否则复用数据目录里的 session-secret 文件，没有就生成一个（权限 0600）。
 */
export function resolveSessionSecret(
  dataDir: string,
  fromEnv: string | null,
): string {
  if (fromEnv) return fromEnv;
  const file = join(dataDir, "session-secret");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  // 文件已存在（内容不合格被覆盖）时 mode 不生效，再设一次
  chmodSync(file, 0o600);
  return secret;
}

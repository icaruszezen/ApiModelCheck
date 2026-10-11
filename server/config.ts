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
  trustProxy: boolean;
  schedulerTickSeconds: number;
}

/** 认证与请求处理需要的那部分配置（createApp 用） */
export interface AuthConfig {
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  trustProxy: boolean;
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

function parseBoolEnv(env: Env, name: string): boolean {
  const raw = nonEmpty(env[name])?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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
    trustProxy: parseBoolEnv(env, "TRUST_PROXY"),
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
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  // 文件已存在（内容不合格被覆盖）时 mode 不生效，再设一次
  chmodSync(file, 0o600);
  return secret;
}

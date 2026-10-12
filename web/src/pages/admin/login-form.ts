/** 登录表单的校验 */
import type { LoginInput } from "../../../../shared/types.ts";
import type { FormResult } from "./shell-form";

export type LoginField = "username" | "password";

export function validateLogin(
  username: string,
  password: string,
): FormResult<LoginField, LoginInput> {
  // 服务端读 ADMIN_USERNAME 时去了首尾空白，所以用户名可以放心去掉；密码原样提交
  const name = username.trim();
  const errors: FormResult<LoginField, LoginInput>["errors"] = {};
  if (!name) errors.username = "请输入用户名";
  if (password === "") errors.password = "请输入密码";
  if (errors.username || errors.password) return { errors, input: null };
  return { errors: {}, input: { username: name, password } };
}

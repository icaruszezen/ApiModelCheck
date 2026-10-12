import { describe, expect, it } from "vitest";
import { validateLogin } from "./login-form";

describe("validateLogin", () => {
  it("两项都要填；用户名去空白，密码原样", () => {
    expect(validateLogin(" ", "")).toEqual({
      errors: { username: "请输入用户名", password: "请输入密码" },
      input: null,
    });
    expect(validateLogin(" admin ", " p w ")).toEqual({
      errors: {},
      input: { username: "admin", password: " p w " },
    });
  });
});

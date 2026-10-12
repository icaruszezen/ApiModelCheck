import { IconButton, Tooltip, useTheme } from "@endfield-ui/react";
import { MoonIcon, SunIcon } from "./icons";

/** 亮 / 暗主题切换；选择记在 localStorage，下次打开沿用 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const label = dark ? "切换到亮色" : "切换到暗色";
  return (
    <Tooltip content={label}>
      <IconButton aria-label={label} onClick={() => setTheme(dark ? "light" : "dark")}>
        {dark ? <SunIcon /> : <MoonIcon />}
      </IconButton>
    </Tooltip>
  );
}

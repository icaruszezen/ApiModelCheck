import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const NowContext = createContext<number>(0);

export interface NowProviderProps {
  /** 服务器时钟比浏览器快多少毫秒，见 clockOffset */
  offset: number;
  /** 有检测在进行时每秒走一次（显示"已进行 N 秒"），否则 15 秒一次就够 */
  fast: boolean;
  children: ReactNode;
}

/**
 * 页面上的"现在"。放在 context 里，只有读它的几个小件随时钟重绘；
 * 输出、网页预览这些重的部分不跟着每秒刷新。
 */
export function NowProvider({ offset, fast, children }: NowProviderProps) {
  const [clientNow, setClientNow] = useState(() => Date.now());
  useEffect(() => {
    setClientNow(Date.now());
    const id = setInterval(
      () => setClientNow(Date.now()),
      fast ? 1_000 : 15_000,
    );
    return () => clearInterval(id);
  }, [fast]);
  return <NowContext value={clientNow + offset}>{children}</NowContext>;
}

/** 按服务器时钟校正过的当前时间（毫秒） */
export function useNow(): number {
  return useContext(NowContext);
}

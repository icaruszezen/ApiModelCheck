/**
 * 后台表格钉在右缘的操作列（纯样式和 DOM 操作，不依赖组件库，方便测）。各页从 ui.tsx 引入。
 */

/*
 * 表格最后一列（操作）钉在右缘：表格放不下要横向滚动时（窄屏、列多），操作也一直看得见。
 * 画法照组件库冻结的第一列：表身的格子拿行的底色（--row-bg，悬停时跟着变）当底，
 * 真的溢出时左缘多一条线，看得出下面压着别的列
 */
export const STICKY_END_HEAD =
  "sticky right-0 z-1 border-line group-data-overflowing/table:border-l";
export const STICKY_END_CELL =
  "sticky right-0 z-1 bg-(--row-bg) group-data-overflowing/table:border-l";

/** 聚焦的元素和钉住的列之间再空一点，焦点框不被压住 */
const STICKY_END_GAP = 8;

/**
 * 给操作列的表头格当 ref：表格横向滚动时，被钉住的操作列压着的格子（启用开关、"下次检测"）
 * 用 Tab 聚焦后要能露出来。做法是让滚动容器右侧的 scroll-padding 和操作列一样宽，
 * 浏览器把聚焦的元素滚进视野时会避开这一段。
 * 各表的操作列宽度不一样（一个按钮到"测试连接"加两个按钮），还随内容和字号变，所以量出来写上
 */
export function stickyEndHeadRef(cell: HTMLTableCellElement | null) {
  // 组件库的 Table 把 <table> 包在横向滚动的容器里
  const scroller = cell?.closest("table")?.parentElement;
  if (!cell || !scroller) return;
  const write = () =>
    scroller.style.setProperty(
      "scroll-padding-inline-end",
      `${cell.offsetWidth + STICKY_END_GAP}px`,
    );
  write();
  if (typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(write);
  observer.observe(cell);
  return () => {
    observer.disconnect();
    scroller.style.removeProperty("scroll-padding-inline-end");
  };
}

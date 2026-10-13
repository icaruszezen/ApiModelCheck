/*
 * 卡片里用圆点隔开的一行小字（标题下的设置、结果的信息行）。圆点画在每一项左边的空白里，
 * 整行往左挪出一个空白、外层裁掉：折到下一行时，行首那一项的圆点落在边界外面看不见，
 * 不会出现以圆点开头的一行。圆点只给眼睛看，替代文字留空，读屏不念
 */

/** 外层：裁掉挪出去的那一截 */
export const META_CLIP = "min-w-0 overflow-hidden";

/** 放各项的那一层（通常是 <dl>） */
export const META_ROW = "-ml-3.5 flex flex-wrap items-baseline";

/** 每一项 */
export const META_ITEM =
  "relative pl-3.5 before:absolute before:left-[5px] before:text-ink-disabled before:content-['·'/'']";

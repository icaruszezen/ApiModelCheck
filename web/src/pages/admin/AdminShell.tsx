/**
 * 后台外壳：宽屏是左边的侧轨，窄于 1280px 换成顶栏 + 全屏菜单（是换一套，不是把侧轨缩小）。
 * 后台几页都是列很多的表格，1024–1279px 之间把侧轨的宽度让给表格。
 * 两套导航用同一份栏目表，当前栏目从地址里认。
 */
import {
  IconButton,
  Menu,
  NavAction,
  NavMenu,
  NavMenuItem,
  SideRail,
  SideRailItem,
  Tooltip,
  TopBar,
} from "@endfield-ui/react";
import { useEffect, type ComponentType, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { BrandMark } from "../../components/BrandMark";
import {
  ChannelIcon,
  ExternalIcon,
  LogoutIcon,
  ModelIcon,
  PromptIcon,
  ResultsIcon,
  SettingsIcon,
} from "../../components/icons";
import { ThemeToggle } from "../../components/ThemeToggle";
import {
  ADMIN_SECTIONS,
  adminDocumentTitle,
  DEFAULT_ADMIN_PATH,
  sectionFromPath,
  type AdminSection,
} from "./shell-nav";
import { useAdminSession, useDocumentTitle } from "./shell-session";

const SECTION_ICONS: Record<AdminSection, ComponentType> = {
  models: ModelIcon,
  channels: ChannelIcon,
  prompts: PromptIcon,
  results: ResultsIcon,
  settings: SettingsIcon,
};

const BRAND_TITLE = "管理后台";

function BrandLink() {
  return (
    <Link
      to={DEFAULT_ADMIN_PATH}
      aria-label={`${BRAND_TITLE}首页`}
      className="flex min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      <BrandMark title={BRAND_TITLE} className="min-w-0" />
    </Link>
  );
}

/** "查看前台"：新标签页打开检测页，后台这边的编辑不受影响 */
function FrontPageAction() {
  return (
    <NavAction href="/" target="_blank" rel="noopener" icon={<ExternalIcon />}>
      查看前台
      <span className="sr-only">（在新标签页打开）</span>
    </NavAction>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const current = sectionFromPath(pathname);
  const { username, logout, loggingOut } = useAdminSession();

  useDocumentTitle(adminDocumentTitle(current));

  // 换栏目时回到页顶：各页长短不一，停在上一页的滚动位置上会让人找不到页头
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [current]);

  return (
    <div className="flex min-h-dvh bg-surface text-ink">
      <SideRail
        aria-label="后台导航"
        className="hidden xl:flex"
        brand={<BrandLink />}
        tools={
          <>
            <ThemeToggle />
            <Tooltip content="退出登录">
              <IconButton
                aria-label="退出登录"
                disabled={loggingOut}
                onClick={() => void logout()}
              >
                <LogoutIcon />
              </IconButton>
            </Tooltip>
          </>
        }
        action={<FrontPageAction />}
        footer={
          <span className="truncate" title={username}>
            已登录 · <span className="font-tech">{username}</span>
          </span>
        }
      >
        {ADMIN_SECTIONS.map((section) => {
          const Icon = SECTION_ICONS[section.key];
          return (
            <SideRailItem
              key={section.key}
              icon={<Icon />}
              current={section.key === current}
              render={<Link to={section.path} />}
            >
              {section.label}
            </SideRailItem>
          );
        })}
      </SideRail>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          className="xl:hidden"
          brand={<BrandLink />}
          tools={<ThemeToggle />}
          menu={
            <NavMenu
              trigger={
                <IconButton aria-label="打开菜单">
                  <Menu />
                </IconButton>
              }
              title="后台菜单"
              brand={<BrandMark title={BRAND_TITLE} />}
              ghost="Admin"
              footer={
                <>
                  <FrontPageAction />
                  <NavAction
                    icon={<LogoutIcon />}
                    disabled={loggingOut}
                    onClick={() => void logout()}
                  >
                    {loggingOut ? "正在退出…" : `退出登录（${username}）`}
                  </NavAction>
                </>
              }
            >
              {ADMIN_SECTIONS.map((section) => {
                const Icon = SECTION_ICONS[section.key];
                return (
                  <NavMenuItem
                    key={section.key}
                    icon={<Icon />}
                    current={section.key === current}
                    render={<Link to={section.path} />}
                  >
                    {section.label}
                  </NavMenuItem>
                );
              })}
            </NavMenu>
          }
        />

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-12 lg:px-8 lg:pt-8">
          {children}
        </main>
      </div>
    </div>
  );
}

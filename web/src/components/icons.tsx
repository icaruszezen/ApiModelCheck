/**
 * 业务图标：照组件库的画法（24 网格、2px 描边、平头端点、尖角拐角）用 createIcon 画的。
 * 颜色跟着文字走，默认对读屏隐藏。
 */
import { createIcon } from "@endfield-ui/react";

export const SunIcon = createIcon(
  "Sun",
  <>
    <rect x="8" y="8" width="8" height="8" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
  </>,
);

export const MoonIcon = createIcon(
  "Moon",
  <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
);

export const RefreshIcon = createIcon(
  "Refresh",
  <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />,
);

export const PlayIcon = createIcon("Play", <path d="M7 4l12 8-12 8z" />);

export const EditIcon = createIcon(
  "Edit",
  <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />,
);

export const TrashIcon = createIcon(
  "Trash",
  <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
);

export const CopyIcon = createIcon(
  "Copy",
  <path d="M8 8h12v12H8zM16 8V4H4v12h4" />,
);

export const ExpandIcon = createIcon(
  "Expand",
  <path d="M4 10V4h6M20 10V4h-6M4 14v6h6M20 14v6h-6" />,
);

export const CodeIcon = createIcon(
  "Code",
  <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />,
);

export const EyeIcon = createIcon(
  "Eye",
  <>
    <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
    <rect x="10" y="10" width="4" height="4" />
  </>,
);

export const ChannelIcon = createIcon(
  "Channel",
  <path d="M3 6h18M3 12h18M3 18h18M7 4v4M15 10v4M11 16v4" />,
);

export const ModelIcon = createIcon(
  "Model",
  <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5" />,
);

export const PromptIcon = createIcon(
  "Prompt",
  <path d="M4 4h16v12H9l-5 4zM8 9h8M8 12h5" />,
);

export const ResultsIcon = createIcon(
  "Results",
  <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
);

export const SettingsIcon = createIcon(
  "Settings",
  <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" />,
);

export const LogoutIcon = createIcon(
  "Logout",
  <path d="M10 4H4v16h6M14 8l4 4-4 4M18 12H9" />,
);

export const ExternalIcon = createIcon(
  "External",
  <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
);

import type { SVGProps } from "react";

/**
 * The Studio's icons: one small inline-SVG set, drawn on a 20-unit grid with a
 * 1.6 stroke so they sit with Inter at the Studio's 15px body size.
 *
 * Inline rather than an icon font or a package, for the same reason the
 * participant app draws its illustrations inline: nothing to fetch, nothing to
 * licence, and they inherit `currentColor` so state is carried by the text
 * colour and never by the icon alone. An icon is always decorative
 * (`aria-hidden`); the control it sits in carries the accessible name.
 */

export type IconName =
  | "plus"
  | "trash"
  | "archive"
  | "restore"
  | "copy"
  | "grip"
  | "chevron-down"
  | "chevron-right"
  | "chevron-left"
  | "search"
  | "lock"
  | "unlock"
  | "eye"
  | "eye-off"
  | "publish"
  | "undo"
  | "redo"
  | "check"
  | "close"
  | "warning"
  | "error"
  | "info"
  | "history"
  | "settings"
  | "user"
  | "logout"
  | "desktop"
  | "tablet"
  | "phone"
  | "restart"
  | "play"
  | "branch"
  | "section"
  | "arrow-up"
  | "arrow-down"
  | "more"
  | "offline"
  | "type-short"
  | "type-long"
  | "type-single"
  | "type-multi"
  | "type-dropdown"
  | "type-number"
  | "type-date"
  | "type-info"
  | "type-rating"
  | "type-slider"
  | "type-yesno"
  | "type-consent"
  | "type-ladder"
  | "type-fields"
  | "type-rank"
  | "welcome"
  | "flag"
  | "story"
  | "external"
  | "compare"
  | "import"
  | "keyboard"
  | "link"
  | "folder"
  | "library";

const paths: Record<IconName, JSX.Element> = {
  plus: <path d="M10 4v12M4 10h12" />,
  trash: <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />,
  archive: <path d="M3 5h14v3H3zM4.5 8v8h11V8M8 11h4" />,
  restore: <path d="M4 10a6 6 0 1 0 2-4.5M4 4v3h3" />,
  copy: <path d="M7 7h9v9H7zM4 13V4h9" />,
  grip: (
    <g>
      <circle cx="7.5" cy="5" r="1" />
      <circle cx="12.5" cy="5" r="1" />
      <circle cx="7.5" cy="10" r="1" />
      <circle cx="12.5" cy="10" r="1" />
      <circle cx="7.5" cy="15" r="1" />
      <circle cx="12.5" cy="15" r="1" />
    </g>
  ),
  "chevron-down": <path d="M5 8l5 5 5-5" />,
  "chevron-right": <path d="M8 5l5 5-5 5" />,
  "chevron-left": <path d="M12 5l-5 5 5 5" />,
  search: <path d="M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12zM13.5 13.5L17 17" />,
  lock: <path d="M5 9h10v8H5zM7 9V6a3 3 0 0 1 6 0v3" />,
  unlock: <path d="M5 9h10v8H5zM7 9V6a3 3 0 0 1 5.8-1" />,
  eye: <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10zM10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />,
  "eye-off": <path d="M4.5 6.3C2.9 7.8 2 10 2 10s3 5.5 8 5.5c1.4 0 2.6-.4 3.7-1M8 4.8c.6-.2 1.3-.3 2-.3 5 0 8 5.5 8 5.5s-.7 1.3-2 2.7M8.2 8.3a2.5 2.5 0 0 0 3.5 3.5M3 3l14 14" />,
  publish: <path d="M10 14V3M5.5 7.5L10 3l4.5 4.5M4 17h12" />,
  undo: <path d="M7 5L3 9l4 4M3 9h9a4 4 0 0 1 0 8H9" />,
  redo: <path d="M13 5l4 4-4 4M17 9H8a4 4 0 0 0 0 8h3" />,
  check: <path d="M4 10.5l4 4 8-9" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  warning: <path d="M10 3L2 17h16L10 3zM10 8v4M10 14.5v.5" />,
  error: <path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM7 7l6 6M13 7l-6 6" />,
  info: <path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM10 9v5M10 6v.5" />,
  history: <path d="M3 10a7 7 0 1 0 2-5M3 4v3h3M10 6v4l3 2" />,
  settings: (
    <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8" />
  ),
  user: <path d="M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 17.5a6.5 6.5 0 0 1 13 0" />,
  logout: <path d="M8 4H4v12h4M12 6l4 4-4 4M16 10H7" />,
  desktop: <path d="M3 4h14v10H3zM7 17h6M10 14v3" />,
  tablet: <path d="M5 2.5h10v15H5zM9 15h2" />,
  phone: <path d="M6.5 2.5h7v15h-7zM9.3 15h1.4" />,
  restart: <path d="M4 10a6 6 0 1 0 2-4.5M4 4v3h3" />,
  play: <path d="M6 4l10 6-10 6z" />,
  branch: <path d="M6 3v14M6 8c0 3 8 2 8 6v3M6 17h0M14 3v4" />,
  section: <path d="M3 5h14M3 10h14M3 15h9" />,
  "arrow-up": <path d="M10 16V4M5 9l5-5 5 5" />,
  "arrow-down": <path d="M10 4v12M5 11l5 5 5-5" />,
  more: (
    <g>
      <circle cx="5" cy="10" r="1.2" />
      <circle cx="10" cy="10" r="1.2" />
      <circle cx="15" cy="10" r="1.2" />
    </g>
  ),
  offline: <path d="M3 3l14 14M6.5 9.5A7 7 0 0 1 10 8.8M3 7a11 11 0 0 1 3-1.8M14 11.5a5 5 0 0 0-1.5-1M17 7.2a11 11 0 0 0-5-2.5M10 15v.5" />,
  "type-short": <path d="M3 13h14M5 9h6" />,
  "type-long": <path d="M3 5h14M3 9h14M3 13h14M3 17h8" />,
  "type-single": (
    <g>
      <circle cx="5.5" cy="6" r="2" />
      <circle cx="5.5" cy="14" r="2" />
      <path d="M10 6h7M10 14h7" />
    </g>
  ),
  "type-multi": <path d="M3.5 4h4v4h-4zM3.5 12h4v4h-4zM4.5 6l1 1 1.5-2M10 6h7M10 14h7" />,
  "type-dropdown": <path d="M3 6h14v8H3zM11.5 9l1.5 1.5L14.5 9" />,
  "type-number": <path d="M7 3L5 17M13 3l-2 14M3.5 7.5h13M3 12.5h13" />,
  "type-date": <path d="M3 5h14v12H3zM3 9h14M7 3v4M13 3v4" />,
  "type-info": <path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM10 9v5M10 6v.5" />,
  "type-rating": <path d="M3 14h2.5v3H3zM8.8 11h2.5v6H8.8zM14.5 7H17v10h-2.5z" />,
  "type-slider": (
    <g>
      <path d="M3 10h14" />
      <circle cx="12" cy="10" r="2.5" />
    </g>
  ),
  "type-yesno": <path d="M3 10.5l3 3 5-6M13 7l4 6M17 7l-4 6" />,
  "type-consent": <path d="M4 4h12v12H4zM7 10l2 2 4-4.5" />,
  "type-ladder": <path d="M6 2v16M14 2v16M6 5h8M6 9h8M6 13h8" />,
  "type-fields": <path d="M3 4h14v4H3zM3 12h14v4H3z" />,
  "type-rank": <path d="M3 5h3M3 10h3M3 15h3M9 5h8M9 10h6M9 15h4" />,
  welcome: <path d="M3 17V8l7-5 7 5v9h-5v-5H8v5z" />,
  flag: <path d="M5 18V3M5 4h10l-2 3.5L15 11H5" />,
  story: <path d="M3 4h14v9H9l-4 3.5V13H3zM6.5 7.5h7M6.5 10h4.5" />,
  external: <path d="M11 3h6v6M17 3l-8 8M14 12v5H3V6h5" />,
  compare: <path d="M7 3v14M13 3v14M3 7h4M13 13h4M3 13l4-3M17 7l-4 3" />,
  import: <path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M3.5 13v3.5h13V13" />,
  keyboard: <path d="M2.5 5.5h15v9h-15zM5.5 8.5h1M9.5 8.5h1M13.5 8.5h1M6.5 11.5h7" />,
  link: <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1.2 1.2M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1.2-1.2" />,
  folder: <path d="M2.5 5h5l1.5 2h8.5v9h-15z" />,
  library: <path d="M3.5 3.5h3v13h-3zM8 3.5h3v13H8zM12.6 4.3l2.9-.8 2.9 12.6-2.9.7z" />,
};

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="st-icon"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}

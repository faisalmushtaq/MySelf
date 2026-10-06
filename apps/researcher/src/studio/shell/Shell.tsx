import { useMemo, useRef, type ReactNode } from "react";
import { atLeast } from "@myself/studio";
import { useOnline, useStudioSession } from "../data/index.js";
import { ROLE_NAMES } from "../format.js";
import { Link, guardedAction, leaveStudio, navigate, type Route } from "../router.js";
import { Icon, type IconName } from "../ui/icons.js";
import { MenuButton, VisuallyHidden, type MenuItem } from "../ui/kit.js";
import { StudySwitcher } from "./StudySwitcher.js";

/**
 * The frame around every Studio page: a quiet 48px header (the mark, where you
 * are, the page's sections, who you are), a skip link, and the offline banner.
 * The survey being built is the loudest thing on screen; this is not.
 */

export interface ShellTab {
  label: string;
  to: Route;
  current: boolean;
}

/** A study space's own pages, as the header's tabs: its surveys, and the item library (D-57). */
export function studyTabs(current: "surveys" | "library"): ShellTab[] {
  return [
    { label: "Surveys", to: { name: "surveys" }, current: current === "surveys" },
    { label: "Library", to: { name: "library" }, current: current === "library" },
  ];
}

export function Shell({
  crumb,
  tabs,
  navLabel = "Survey",
  banner,
  children,
  wide = false,
  menuItems,
}: {
  /** Where you are, after the mark: a survey's title, "Playground". */
  crumb?: ReactNode;
  tabs?: ShellTab[];
  /** What the tabs are the pages of, for screen readers: a survey's, or the study space's. */
  navLabel?: string;
  /** Page-wide messages under the header (the playground label, a conflict). */
  banner?: ReactNode;
  children: ReactNode;
  /** Full width for the editor; list pages keep a readable measure. */
  wide?: boolean;
  /** Extra account-menu items for this page, such as the editor's keyboard shortcuts. */
  menuItems?: MenuItem[] | undefined;
}) {
  const main = useRef<HTMLElement | null>(null);
  const online = useOnline();

  return (
    <div className="studio stp-app">
      <a
        className="stp-skip"
        href="#studio-main"
        onClick={(e) => {
          // A plain fragment link would change the hash — and a hash that is
          // not "#/…" is the researcher view's, not the Studio's.
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="stp-header">
        <div className="stp-header-inner">
          <div className="stp-brand">
            <Link to={{ name: "surveys" }} className="stp-home">
              <StudioMark />
              <span>
                <VisuallyHidden>MySelf </VisuallyHidden>Studio
              </span>
            </Link>
            <StudySwitcher />
            {crumb ? (
              <>
                <span className="stp-crumb-sep" aria-hidden="true">
                  /
                </span>
                <span className="stp-crumb">{crumb}</span>
              </>
            ) : null}
          </div>
          {tabs && tabs.length > 0 ? (
            <nav className="stp-nav" aria-label={navLabel}>
              {tabs.map((t) => (
                <Link key={t.label} to={t.to} className={`stp-nav-link${t.current ? " on" : ""}`} aria-current={t.current ? "page" : undefined}>
                  <span>{t.label}</span>
                </Link>
              ))}
            </nav>
          ) : (
            <span className="stp-nav-spacer" />
          )}
          <UserMenu extra={menuItems} />
        </div>
      </header>
      {!online ? (
        <Banner tone="warn" icon="offline" title="You’re offline.">
          Changes stay in this tab and save when the connection returns.
        </Banner>
      ) : null}
      {banner}
      <main id="studio-main" ref={main} tabIndex={-1} className={`stp-main${wide ? " stp-main-wide" : ""}`}>
        {children}
      </main>
    </div>
  );
}

/** The MySelf mark: a small accent square with a white "M". Decorative — the words beside it carry the name. */
export function StudioMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="stp-mark" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect width="20" height="20" rx="5" style={{ fill: "var(--st-accent)" }} />
      <path d="M5.75 14V6.25L10 11.25L14.25 6.25V14" fill="none" stroke="#ffffff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Two letters for an avatar: from the display name, else the email's local part ("research.lead" → "RL"). */
export function initialsOf(name: string | null | undefined, email: string | null | undefined): string {
  const from = (name ?? "").trim() || (email ?? "").split("@")[0] || "";
  const words = from.split(/[\s._-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "?";
  const first = Array.from(words[0]!)[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1]!)[0] ?? "") : (Array.from(words[0]!)[1] ?? "");
  return `${first}${last}`.toUpperCase();
}

export function Avatar({ name, email }: { name: string | null | undefined; email: string | null | undefined }) {
  return (
    <span className="stp-avatar" aria-hidden="true">
      {initialsOf(name, email)}
    </span>
  );
}

function UserMenu({ extra }: { extra?: MenuItem[] | undefined }) {
  const session = useStudioSession();
  const { user, role, signOut } = session;
  const isAdmin = atLeast(role, "admin");
  const items = useMemo<MenuItem[]>(() => {
    if (!user) return [];
    const list: MenuItem[] = [
      // Who is signed in, and as what — a label, not an action.
      { label: user.email ?? "Signed in", onSelect: () => undefined, disabled: true, ...(role ? { hint: ROLE_NAMES[role] } : {}) },
      ...(extra ?? []),
    ];
    if (isAdmin) list.push({ label: "Who has access", icon: "user", onSelect: () => navigate({ name: "access" }) });
    list.push(
      { label: "Playground", icon: "play", onSelect: () => navigate({ name: "playground", tab: "edit", q: null }) },
      { label: "Researcher view", icon: "external", onSelect: () => void leaveStudio() },
      { label: "Sign out", icon: "logout", onSelect: () => void guardedAction(() => void signOut()) },
    );
    return list;
  }, [user, role, isAdmin, signOut, extra]);

  // A build with no study has nothing to sign in to (the playground's case).
  if (session.status === "unconfigured") return null;
  if (!user) {
    return (
      <div className="stp-user">
        <Link to={{ name: "login", next: null }} className="st-btn st-btn-secondary st-btn-sm">
          Sign in
        </Link>
      </div>
    );
  }
  return (
    <div className="stp-user">
      <MenuButton
        label="Account"
        items={items}
        buttonLabel={
          <>
            <Avatar name={user.displayName} email={user.email} />
            <VisuallyHidden>
              Account: {user.email ?? "signed in"}
              {role ? `, ${ROLE_NAMES[role]}` : ""}
            </VisuallyHidden>
          </>
        }
      />
    </div>
  );
}

/** A page's title block: heading, one line of context, and its actions (top right). */
export function PageHead({ title, lede, actions }: { title: string; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="stp-page-head">
      <div>
        <h1 className="stp-h1">{title}</h1>
        {lede ? <p className="stp-lede">{lede}</p> : null}
      </div>
      {actions ? <div className="stp-page-actions">{actions}</div> : null}
    </div>
  );
}

export type BannerTone = "neutral" | "warn" | "error" | "accent";

const BANNER_ICONS: Record<BannerTone, IconName> = { neutral: "info", warn: "warning", error: "error", accent: "restore" };

/**
 * A page-wide message as one slim line under the header (DESIGN.md §5): an
 * icon, a few words, and the action on the right. Only for states that block
 * work. Errors are announced (role=alert); the rest are polite.
 */
export function Banner({
  tone = "neutral",
  icon,
  title,
  children,
  action,
  more,
  role,
}: {
  tone?: BannerTone;
  icon?: IconName;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** Shown on its own row under the line (a disclosure's content, say). */
  more?: ReactNode;
  role?: "alert" | "status" | "note";
}) {
  return (
    <div className={`stp-banner stp-banner-${tone}`} role={role ?? (tone === "error" ? "alert" : "status")}>
      <Icon name={icon ?? BANNER_ICONS[tone]} size={16} />
      <div className="stp-banner-text">
        {title ? <strong>{title}</strong> : null}
        {title && children ? " " : null}
        {children ? <span className="stp-banner-detail">{children}</span> : null}
      </div>
      {action ? <div className="stp-banner-action">{action}</div> : null}
      {more ? <div className="stp-banner-more">{more}</div> : null}
    </div>
  );
}

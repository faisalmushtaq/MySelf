import { useRef, type ReactNode } from "react";
import { atLeast } from "@myself/studio";
import { useOnline, useStudioSession } from "../data/index.js";
import { ROLE_NAMES } from "../format.js";
import { Link, guardedAction, leaveStudio, navigate, type Route } from "../router.js";
import { Icon } from "../ui/icons.js";
import { Badge, MenuButton, VisuallyHidden, type MenuItem } from "../ui/kit.js";

/**
 * The frame around every Studio page: a quiet sticky header (wordmark, where
 * you are, the page's sections, who you are), a skip link, and the offline
 * banner. The survey being built is the loudest thing on screen; this is not.
 */

export interface ShellTab {
  label: string;
  to: Route;
  current: boolean;
}

export function Shell({
  crumb,
  tabs,
  banner,
  children,
  wide = false,
}: {
  /** Where you are, after the wordmark: a survey's title, "Playground". */
  crumb?: ReactNode;
  tabs?: ShellTab[];
  /** Page-wide messages under the header (the playground label, a conflict). */
  banner?: ReactNode;
  children: ReactNode;
  /** Full width for the editor; list pages keep a readable measure. */
  wide?: boolean;
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
            <Link to={{ name: "surveys" }} className="stp-wordmark">
              MySelf <span>Studio</span>
            </Link>
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
            <nav className="stp-nav" aria-label="Survey">
              {tabs.map((t) => (
                <Link key={t.label} to={t.to} className={`stp-nav-link${t.current ? " on" : ""}`} aria-current={t.current ? "page" : undefined}>
                  {t.label}
                </Link>
              ))}
            </nav>
          ) : (
            <span className="stp-nav-spacer" />
          )}
          <UserMenu />
        </div>
      </header>
      {!online ? (
        <div className="stp-offline" role="status">
          <Icon name="offline" size={16} />
          <span>
            <strong>You&rsquo;re offline.</strong> Changes stay in this tab and are saved when the connection returns.
          </span>
        </div>
      ) : null}
      {banner}
      <main id="studio-main" ref={main} tabIndex={-1} className={`stp-main${wide ? " stp-main-wide" : ""}`}>
        {children}
      </main>
    </div>
  );
}

function UserMenu() {
  const session = useStudioSession();
  // A build with no study has nothing to sign in to (the playground's case).
  if (session.status === "unconfigured") return null;
  if (!session.user) {
    return (
      <div className="stp-user">
        <Link to={{ name: "login", next: null }} className="st-btn st-btn-secondary st-btn-sm">
          Sign in
        </Link>
      </div>
    );
  }
  const items: MenuItem[] = [];
  if (atLeast(session.role, "admin")) {
    items.push({ label: "Who has access", icon: "user", onSelect: () => navigate({ name: "access" }) });
  }
  items.push(
    { label: "Playground (nothing saved)", icon: "play", onSelect: () => navigate({ name: "playground", tab: "edit", q: null }) },
    { label: "Researcher view", icon: "external", onSelect: () => void leaveStudio() },
    { label: "Sign out", icon: "logout", onSelect: () => void guardedAction(() => void session.signOut()) },
  );
  return (
    <div className="stp-user">
      <MenuButton
        label="Account"
        icon="user"
        items={items}
        buttonLabel={
          <span className="stp-user-label">
            <VisuallyHidden>Account: </VisuallyHidden>
            <span className="stp-user-email">{session.user.email ?? "Signed in"}</span>
            {session.role ? <Badge tone="muted">{ROLE_NAMES[session.role]}</Badge> : null}
          </span>
        }
      />
    </div>
  );
}

/** A page's title block: heading, one line of context, and its actions. */
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

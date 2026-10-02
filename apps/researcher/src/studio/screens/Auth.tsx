import { useEffect, useState, type ReactNode } from "react";
import { useStudioSession } from "../data/index.js";
import { studyContact } from "../contact.js";
import { Link, formatRoute, leaveStudio, navigate, parseHash, safeNext, type Route } from "../router.js";
import { Avatar, StudioMark } from "../shell/Shell.js";
import { Icon } from "../ui/icons.js";
import { Button, Notice, Spinner } from "../ui/kit.js";

/**
 * The pages a person sees before they are in: signing in, being told they are
 * not on the list, and the rare case of the session check itself failing.
 * Each says what happened and what to do next, in as few words as that takes.
 */

function AuthFrame({ children, playground = true }: { children: ReactNode; playground?: boolean }) {
  return (
    <div className="studio stp-auth">
      <main id="studio-main" tabIndex={-1} className="stp-auth-main">
        <StudioMark size={32} />
        {children}
      </main>
      <p className="stp-auth-foot">
        {playground ? (
          <Link to={{ name: "playground", tab: "edit", q: null }} className="stp-plain">
            Playground
          </Link>
        ) : null}
        <button type="button" className="stp-textlink" onClick={() => void leaveStudio()}>
          Researcher view
        </button>
      </p>
    </div>
  );
}

/** Google's "G", as its sign-in buttons show it. Decorative: the button's words carry the name. */
function GoogleG() {
  return (
    <svg className="stp-google" width="16" height="16" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function LoginScreen({ next }: { next: string | null }) {
  const session = useStudioSession();
  const [busy, setBusy] = useState(false);

  // Signed in with a role already (or just now): go where they were heading.
  useEffect(() => {
    if (session.status === "ready") {
      const target = safeNext(next);
      navigate(target ? parseHash(target) : { name: "surveys" }, { replace: true });
    }
  }, [session.status, next]);

  if (session.status === "unconfigured") {
    return (
      <AuthFrame playground={false}>
        <h1 className="stp-auth-title">Not connected to a study</h1>
        <p className="stp-auth-lede">This build has no Firebase settings, so nothing can be saved or published from it.</p>
        <div className="stp-auth-actions">
          <Link to={{ name: "playground", tab: "edit", q: null }} className="st-btn st-btn-primary st-btn-md">
            <Icon name="play" size={16} />
            <span>Open the playground</span>
          </Link>
        </div>
        <p className="stp-auth-small">The live survey in the editor, with nothing saved.</p>
      </AuthFrame>
    );
  }

  if (session.status === "unauthorised") return <UnauthorisedScreen />;
  if (session.status === "error") return <SessionErrorScreen />;

  const checking = session.status === "loading" || session.status === "ready";
  return (
    <AuthFrame playground={false}>
      <h1 className="stp-auth-title">Sign in to MySelf Studio</h1>
      <p className="stp-auth-lede">Use the Google account your team added to the Studio.</p>
      {session.error ? (
        <div className="stp-auth-body">
          <Notice tone="error">{session.error}</Notice>
        </div>
      ) : null}
      <div className="stp-auth-actions">
        {checking ? (
          <p className="stp-checking" role="status">
            <Spinner /> Checking who you are…
          </p>
        ) : (
          <Button
            variant="secondary"
            busy={busy}
            onClick={() => {
              setBusy(true);
              void session.signIn().finally(() => setBusy(false));
            }}
          >
            {busy ? null : <GoogleG />}
            Sign in with Google
          </Button>
        )}
      </div>
      <p className="stp-auth-small">
        Just looking? <Link to={{ name: "playground", tab: "edit", q: null }}>Try the playground</Link>, where nothing is
        saved.
      </p>
    </AuthFrame>
  );
}

const REASONS: Record<string, { title: string; body: (email: ReactNode) => ReactNode }> = {
  not_listed: {
    title: "You don’t have access yet",
    body: (email) => <>Ask a Studio admin to add {email}, then check again.</>,
  },
  email_not_verified: {
    title: "Email not verified",
    body: (email) => <>Google hasn&rsquo;t verified {email} yet. Follow Google&rsquo;s verification email, then check again.</>,
  },
  not_google: {
    title: "Google accounts only",
    body: () => <>Sign out, then sign in with a Google account (a Google Workspace work account is fine).</>,
  },
};

export function UnauthorisedScreen() {
  const session = useStudioSession();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const email = session.user?.email ?? null;
  const reason = REASONS[session.reason ?? "not_listed"] ?? REASONS["not_listed"]!;
  const contact = studyContact();
  return (
    <AuthFrame>
      <h1 className="stp-auth-title">{reason.title}</h1>
      <div className="stp-auth-account">
        <Avatar name={session.user?.displayName} email={email} />
        <span>{email ?? "Signed in"}</span>
      </div>
      <p className="stp-auth-lede">{reason.body(email ? "this address" : "this account")}</p>
      {checked && !checking ? (
        <div className="stp-auth-body">
          <Notice tone="warn">Still no access. It can take a moment after an admin adds you.</Notice>
        </div>
      ) : null}
      <div className="stp-auth-actions two">
        <Button
          variant="primary"
          icon="restart"
          busy={checking}
          onClick={() => {
            setChecking(true);
            void session.refresh().finally(() => {
              setChecking(false);
              setChecked(true);
            });
          }}
        >
          Check again
        </Button>
        <Button variant="secondary" icon="logout" onClick={() => void session.signOut()}>
          Sign out
        </Button>
      </div>
      <p className="stp-auth-small">
        Added under another address? Sign out and use that one.
        {contact ? (
          <>
            <br />
            Not sure who your admin is? Ask <a href={`mailto:${contact}`}>{contact}</a>.
          </>
        ) : null}
      </p>
    </AuthFrame>
  );
}

export function SessionErrorScreen() {
  const session = useStudioSession();
  const [busy, setBusy] = useState(false);
  return (
    <AuthFrame>
      <h1 className="stp-auth-title">Couldn&rsquo;t check your access</h1>
      <div className="stp-auth-body">
        <Notice tone="error">{session.error ?? "Something went wrong while checking who you are."}</Notice>
      </div>
      <div className="stp-auth-actions two">
        <Button
          variant="primary"
          icon="restart"
          busy={busy}
          onClick={() => {
            setBusy(true);
            void session.refresh().finally(() => setBusy(false));
          }}
        >
          Try again
        </Button>
        <Button variant="secondary" icon="logout" onClick={() => void session.signOut()}>
          Sign out
        </Button>
      </div>
    </AuthFrame>
  );
}

export function CheckingScreen() {
  return (
    <div className="studio stp-auth">
      <div className="stp-auth-loading" role="status">
        <Spinner /> <span>Opening MySelf Studio…</span>
      </div>
    </div>
  );
}

/** Replaces the address with another without adding to history, then shows a quiet loading state. */
export function Redirect({ to }: { to: Route }) {
  const hash = formatRoute(to);
  useEffect(() => {
    navigate(parseHash(hash), { replace: true });
  }, [hash]);
  return <CheckingScreen />;
}

import { useEffect, useState, type ReactNode } from "react";
import { useStudioSession } from "../data/index.js";
import { studyContact } from "../contact.js";
import { Link, formatRoute, leaveStudio, navigate, parseHash, safeNext, type Route } from "../router.js";
import { Icon } from "../ui/icons.js";
import { Button, Notice, Spinner } from "../ui/kit.js";

/**
 * The pages a person sees before they are in: signing in, being told they are
 * not on the list, and the rare case of the session check itself failing.
 * Each says exactly what happened and what to do next.
 */

function AuthFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="studio stp-auth">
      <main id="studio-main" tabIndex={-1} className={`stp-auth-card${wide ? " wide" : ""}`}>
        <p className="stp-auth-mark" aria-hidden="true">
          MySelf <span>Studio</span>
        </p>
        {children}
      </main>
      <p className="stp-auth-foot">
        <button type="button" className="stp-textlink" onClick={() => void leaveStudio()}>
          Back to the researcher view
        </button>
      </p>
    </div>
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
      <AuthFrame>
        <h1 className="stp-auth-title">This copy of the Studio isn&rsquo;t connected to a study</h1>
        <p>
          It was built without the study&rsquo;s Firebase settings, so there is nothing to sign in to and nothing can be
          saved or published from here.
        </p>
        <p>You can still try the editor on the live survey in the playground, where nothing is saved.</p>
        <div className="stp-auth-actions">
          <Link to={{ name: "playground", tab: "edit", q: null }} className="st-btn st-btn-primary st-btn-md">
            <Icon name="play" size={18} />
            <span>Open the playground</span>
          </Link>
        </div>
      </AuthFrame>
    );
  }

  if (session.status === "unauthorised") return <UnauthorisedScreen />;
  if (session.status === "error") return <SessionErrorScreen />;

  const checking = session.status === "loading" || session.status === "ready";
  return (
    <AuthFrame>
      <h1 className="stp-auth-title">Sign in to build and publish the MySelf survey</h1>
      <p>
        The Studio is where the research team edits the questionnaire, previews it as a participant sees it, and
        publishes new versions to the devices in schools. Sign in with the Google account your team added to the Studio
        list. You stay signed in until you close this tab.
      </p>
      {session.error ? (
        <div className="stp-gap">
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
            variant="primary"
            icon="user"
            busy={busy}
            onClick={() => {
              setBusy(true);
              void session.signIn().finally(() => setBusy(false));
            }}
          >
            Sign in with Google
          </Button>
        )}
      </div>
      <p className="stp-auth-small">
        Just looking? <Link to={{ name: "playground", tab: "edit", q: null }}>Try the playground</Link> — the live survey
        in the editor, with nothing saved.
      </p>
    </AuthFrame>
  );
}

const REASONS: Record<string, { title: string; body: (email: string) => ReactNode }> = {
  not_listed: {
    title: "This Google account isn’t on the MySelf Studio list",
    body: (email) => (
      <>
        You&rsquo;re signed in as <strong>{email}</strong>, which hasn&rsquo;t been given access. Ask a Studio admin to
        add this exact address, then press <em>Check again</em>. If you have a work account that was added, sign out
        and sign in with that one.
      </>
    ),
  },
  email_not_verified: {
    title: "Google hasn’t confirmed this email address",
    body: (email) => (
      <>
        The Studio only accepts addresses Google has verified, and <strong>{email}</strong> isn&rsquo;t verified yet.
        Follow the verification email from Google, then press <em>Check again</em>.
      </>
    ),
  },
  not_google: {
    title: "The Studio only accepts Google accounts",
    body: () => <>Sign out, then sign in with a Google account (including a Google Workspace work account).</>,
  },
};

export function UnauthorisedScreen() {
  const session = useStudioSession();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const email = session.user?.email ?? "this account";
  const reason = REASONS[session.reason ?? "not_listed"] ?? REASONS["not_listed"]!;
  const contact = studyContact();
  return (
    <AuthFrame wide>
      <h1 className="stp-auth-title">{reason.title}</h1>
      <p>{reason.body(email)}</p>
      <p className="stp-auth-small">
        Who to ask: whoever manages MySelf Studio for your team
        {contact ? (
          <>
            , or the study team at <a href={`mailto:${contact}`}>{contact}</a>
          </>
        ) : null}
        .
      </p>
      {checked && !checking ? (
        <div className="stp-gap">
          <Notice tone="warn">Still not on the list. It can take a moment after an admin adds you — try again shortly.</Notice>
        </div>
      ) : null}
      <div className="stp-auth-actions">
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
    </AuthFrame>
  );
}

export function SessionErrorScreen() {
  const session = useStudioSession();
  const [busy, setBusy] = useState(false);
  return (
    <AuthFrame>
      <h1 className="stp-auth-title">The Studio couldn&rsquo;t check your access</h1>
      <Notice tone="error">{session.error ?? "Something went wrong while checking who you are."}</Notice>
      <div className="stp-auth-actions">
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
      <div className="stp-auth-card stp-auth-loading" role="status">
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

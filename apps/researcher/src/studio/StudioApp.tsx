import { useEffect, useRef } from "react";
import { useStudioSession } from "./data/index.js";
import { formatRoute, NavigationPrompt, samePage, useRoute, type Route } from "./router.js";
import { AccessScreen } from "./screens/Access.js";
import { CheckingScreen, LoginScreen, Redirect, SessionErrorScreen, UnauthorisedScreen } from "./screens/Auth.js";
import { PlaygroundScreen } from "./screens/Playground.js";
import { SurveyLayout } from "./screens/SurveyLayout.js";
import { SurveysScreen } from "./screens/Surveys.js";
import { Shell } from "./shell/Shell.js";
import { Button, EmptyState } from "./ui/kit.js";
import { navigate } from "./router.js";

/**
 * MySelf Studio: which page to show for the address and the session.
 *
 * The guards here decide only what is SHOWN. Access is enforced by the rules
 * and the functions, which check the allowlist on every request; a person who
 * bypassed this component would find every read and write refused.
 */
export function StudioApp() {
  const route = useRoute();
  const session = useStudioSession();
  usePageChrome(route);

  return (
    <>
      <Page route={route} status={session.status} />
      <NavigationPrompt />
    </>
  );
}

function Page({ route, status }: { route: Route; status: ReturnType<typeof useStudioSession>["status"] }) {
  // Pages anyone can see, signed in or not.
  if (route.name === "playground") return <PlaygroundScreen tab={route.tab} q={route.q} />;
  if (route.name === "login") return <LoginScreen next={route.next} />;

  switch (status) {
    case "loading":
      return <CheckingScreen />;
    case "unconfigured":
    case "signed_out":
      // Remember where they were going, so signing in takes them there.
      return <Redirect to={{ name: "login", next: route.name === "not_found" ? null : formatRoute(route) }} />;
    case "unauthorised":
      return <UnauthorisedScreen />;
    case "error":
      return <SessionErrorScreen />;
    case "ready":
      break;
  }

  switch (route.name) {
    case "surveys":
      return <SurveysScreen />;
    case "access":
      return <AccessScreen />;
    case "survey":
      // Keyed by survey, so opening another survey starts a fresh draft editor
      // rather than carrying one survey's state into the next.
      return <SurveyLayout key={route.surveyId} surveyId={route.surveyId} tab={route.tab} q={route.q} />;
    case "not_found":
      return (
        <Shell>
          <div className="stp-page">
            <EmptyState
              icon="search"
              title="There’s no page at this address"
              action={
                <Button variant="primary" onClick={() => navigate({ name: "surveys" })}>
                  Go to surveys
                </Button>
              }
            >
              <p>
                <code>#{route.path}</code> isn&rsquo;t a Studio page. It may be an old link.
              </p>
            </EmptyState>
          </div>
        </Shell>
      );
  }
}

const TITLES: Record<string, string> = {
  edit: "Edit",
  preview: "Preview",
  versions: "Versions",
  settings: "Settings",
};

/**
 * The document title follows the page, and moving to a new page puts focus at
 * the start of its content — so a screen-reader user hears where they arrived,
 * as they would on a page load. Changing only the selected question does
 * neither: that is the same page.
 */
function usePageChrome(route: Route) {
  const previous = useRef<Route | null>(null);

  // Declared first, so it captures the researcher view's title before the
  // effect below replaces it: leaving the Studio for the researcher view
  // (which never sets a title of its own) must not leave the tab saying
  // "Edit · … — MySelf Studio".
  useEffect(() => {
    const original = document.title;
    return () => {
      document.title = original;
    };
  }, []);

  useEffect(() => {
    const page =
      route.name === "survey"
        ? `${TITLES[route.tab]} · ${route.surveyId}`
        : route.name === "playground"
          ? `Playground · ${TITLES[route.tab]}`
          : route.name === "surveys"
            ? "Surveys"
            : route.name === "access"
              ? "Who has access"
              : route.name === "login"
                ? "Sign in"
                : "Not found";
    document.title = `${page} — MySelf Studio`;
  }, [route]);

  useEffect(() => {
    const before = previous.current;
    previous.current = route;
    if (!before || samePage(before, route)) return;
    // After the new page has rendered. A page still loading has no heading
    // yet: focus its main region, then move to the heading when it appears,
    // unless the person has already moved on.
    let observer: MutationObserver | null = null;
    const focusHeading = (main: HTMLElement): boolean => {
      const heading = main.querySelector<HTMLElement>("h1");
      if (!heading) return false;
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: false });
      return true;
    };
    const t = window.setTimeout(() => {
      const main = document.getElementById("studio-main");
      if (!main || focusHeading(main)) return;
      main.focus();
      observer = new MutationObserver(() => {
        if (document.activeElement !== main) observer?.disconnect();
        else if (focusHeading(main)) observer?.disconnect();
      });
      observer.observe(main, { childList: true, subtree: true });
    }, 0);
    const stop = window.setTimeout(() => observer?.disconnect(), 3000);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(stop);
      observer?.disconnect();
    };
  }, [route]);
}

import { StudioDataProvider } from "./data/index.js";
import { StudioApp } from "./StudioApp.js";
import { ToastProvider } from "./ui/toast.js";
import "./studio.css";
import "./platform.css";

/**
 * The Studio as App.tsx loads it: lazily, as its own chunk, so the researcher
 * view pays nothing for it until someone opens a `#/` address.
 */
export default function StudioRoot() {
  return (
    <ToastProvider>
      <StudioDataProvider>
        <StudioApp />
      </StudioDataProvider>
    </ToastProvider>
  );
}

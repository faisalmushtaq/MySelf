/**
 * Build-time values the Studio reads, baked in by vite.config.ts `define`.
 *
 * `__FIREBASE_CONFIG__` and `__STUDY__` are declared in src/vite-env.d.ts,
 * shared with the researcher view.
 */

/**
 * JSON naming the Firebase emulators to use, or "" for the real project. Only
 * ever set for local development and the end-to-end tests; a build with it
 * empty contains no emulator or test sign-in code at all.
 */
declare const __STUDIO_EMULATORS__: string;

/** The survey "Set up from the live survey" imports, e.g. "ybm_nd2026_standard". */
declare const __SURVEY_ID__: string;

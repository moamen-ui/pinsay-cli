// Values esbuild replaces at build time (see build.mjs `define`).
//
// They MUST be referenced as bare identifiers. esbuild's `define` substitutes identifier
// references only — it does not touch member access, so the previous `(globalThis as any).X` form
// was never replaced and silently fell back to its default. That made the documented
// PINSAY_DEFAULT_SERVER build override dead: a self-hoster building their own CLI always got the
// hardcoded hosted URL.
//
// The `typeof` guard keeps this working under tsx (tests, local dev), where no define runs and the
// identifier genuinely does not exist.
declare const DEFAULT_SERVER: string | undefined;
declare const CLI_VERSION: string | undefined;

export const BUILD_DEFAULT_SERVER: string =
  typeof DEFAULT_SERVER !== 'undefined' ? DEFAULT_SERVER : 'https://app.pinsay.dev';

export const BUILD_CLI_VERSION: string =
  typeof CLI_VERSION !== 'undefined' ? CLI_VERSION : '0.0.0-dev';

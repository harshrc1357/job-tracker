// The only paths reachable without the owner's session. An exact list, checked inside the
// middleware, and not a prefix list in the matcher: the matcher used to exclude `login`,
// `privacy`, `api/sync` and `api/auth/login` as prefixes, so a future route such as
// `/login-admin` or `/api/sync/debug` would have been public without anyone deciding so.
//
//   /login, /api/auth/login, /api/auth/login/callback  signing in has to work signed out
//   /privacy   Google's OAuth consent screen and Search Console fetch it without a session
//   /api/sync  an external cron calls it; it decides for itself what a caller may see
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/login",
  "/privacy",
  "/api/sync",
  "/api/auth/login",
  "/api/auth/login/callback",
]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

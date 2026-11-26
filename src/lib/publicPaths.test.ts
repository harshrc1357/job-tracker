import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, test } from "vitest";
import { config } from "@/middleware";
import { isPublicPath } from "./publicPaths";

describe("isPublicPath", () => {
  test.each(["/login", "/privacy", "/api/sync", "/api/auth/login", "/api/auth/login/callback"])(
    "%s is public",
    (path) => {
      expect(isPublicPath(path)).toBe(true);
    }
  );

  // The old matcher excluded by PREFIX, so each of these skipped sign-in. None exists as
  // a route today; the test keeps a future route under one of these prefixes private.
  test.each([
    "/login-x",
    "/loginx",
    "/LOGIN",
    "/login/x",
    "/privacy-x",
    "/privacy/x",
    "/api/sync-x",
    "/api/sync/x",
    "/api/auth/login-x",
    "/api/auth/google",
    "/api/auth/google/callback",
    "/api/auth/logout",
    "/api/applications/1",
    "/",
    "/inbox",
  ])("%s is not public", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("middleware matcher", () => {
  const matches = (path: string) => unstable_doesMiddlewareMatch({ config, url: `http://localhost${path}` });

  test.each(["/", "/inbox", "/login", "/api/sync", "/login-x", "/api/sync/x", "/api/applications/1"])(
    "%s runs through middleware, which then decides",
    (path) => {
      expect(matches(path)).toBe(true);
    }
  );

  test.each(["/_next/static/chunks/main.js", "/_next/image", "/favicon.ico"])(
    "%s is skipped so the login page can load its own assets",
    (path) => {
      expect(matches(path)).toBe(false);
    }
  );
});

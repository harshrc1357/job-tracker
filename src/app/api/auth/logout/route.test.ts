import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { SESSION_COOKIE_NAME } from "@/lib/session";
import * as logout from "./route";

const URL_ = "http://localhost:3000/api/auth/logout";

function post(origin: string | null) {
  return new NextRequest(URL_, { method: "POST", headers: origin ? { origin } : {} });
}

describe("/api/auth/logout", () => {
  test("has no GET, so a link or an <img> on another site cannot sign the owner out", () => {
    expect("GET" in logout).toBe(false);
  });

  test("a POST from the dashboard's own origin clears the session and goes to /login", async () => {
    const response = await logout.POST(post("http://localhost:3000"));

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") as string).pathname).toBe("/login");
    expect(response.cookies.get(SESSION_COOKIE_NAME)?.value).toBe("");
  });

  test.each(["https://evil.example", null])("a POST with the origin %p is refused and keeps the session", async (origin) => {
    const response = await logout.POST(post(origin));

    expect(response.status).toBe(403);
    expect(response.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });
});

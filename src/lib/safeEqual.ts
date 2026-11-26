import { createHash, timingSafeEqual } from "node:crypto";

// Compares two secrets without leaking, through response time, how many leading
// characters matched. Both sides are hashed first because timingSafeEqual throws on
// buffers of different length, and a length check would itself leak the secret's length.
// Node-only: keep it out of middleware, which runs on the Edge runtime.
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

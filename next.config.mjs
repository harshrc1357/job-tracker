const isProduction = process.env.NODE_ENV === "production";

// Browser hardening headers, sent on every response. The app loads nothing from another
// origin (no CDN fonts, no analytics, no external images), so the policy can be tight.
//
// Not a nonce policy, on purpose: Next injects inline bootstrap scripts, and a nonce would
// force every page to render per request. 'unsafe-inline' for scripts is the price; the
// protection that matters here is elsewhere. Email HTML is sanitized at sync time and shown
// in a sandboxed iframe with no `allow-scripts`, so even a sanitizer bypass cannot run code.
//
//   img-src has no https:, so a remote image in an email cannot load. Opening a message
//     would otherwise tell the sender when, and from which IP address, it was read.
//   frame-ancestors / X-Frame-Options stop another site framing the dashboard.
//   'unsafe-eval' is development only: React's refresh tooling needs it.
//
// Strict-Transport-Security is left to Vercel, which already sends it.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Do not announce the framework in an X-Powered-By header.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

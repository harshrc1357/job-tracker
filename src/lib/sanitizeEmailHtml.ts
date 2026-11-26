import sanitizeHtml from "sanitize-html";

// Strips anything that could execute (script tags, on* handlers, javascript:
// URLs) while keeping everything that makes an email actually look like the
// sender's email — inline styles, tables, fonts, images, colors. Emails are
// laid out with HTML tables and inline CSS almost universally, so a tag/style
// allowlist this permissive is what it takes to render one recognizably.
//
// This is defense in depth, not the only line of defense: the sanitized output
// only ever gets rendered inside a sandboxed iframe with no `allow-scripts`
// (see ApplicationsPanel.tsx), so even something that slipped past this would
// not be able to run. Sanitizing at sync time (once, before it hits the
// database) means the client never re-parses untrusted HTML on every render.
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img",
      "style",
      "font",
      "center",
      "span",
      "div",
      "table",
      "thead",
      "tbody",
      "tr",
      "td",
      "th",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "u",
      "s",
    ]),
    allowedAttributes: {
      "*": [
        "style",
        "class",
        "align",
        "valign",
        "width",
        "height",
        "colspan",
        "rowspan",
        "border",
        "cellpadding",
        "cellspacing",
        "bgcolor",
      ],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["http", "https", "data"],
    },
    // Links open a real new tab instead of trying (and failing) to navigate the
    // sandboxed iframe they're rendered in.
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
    },
  });
}

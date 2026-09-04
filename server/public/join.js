/**
 * Join page behaviour (PLAN 1.5).
 *
 * External rather than inline so the Content-Security-Policy in
 * `server/src/index.ts` can be `script-src 'self'` with no `'unsafe-inline'`
 * and no per-request nonce. A nonce would mean templating what is otherwise a
 * static file on every request; this page has no server-injected content, so
 * there is nothing a nonce would buy.
 */

// Path-style URL: /j/482913 — much easier to read aloud than a query string.
const code = location.pathname.split("/").filter(Boolean)[1] ?? "------";
document.getElementById("code").textContent = code;
document.getElementById("code-inline").textContent = code;

/**
 * Tiny local test site for keyless-recipe runs (used by the nightly CI job and
 * handy locally): no external network needed.
 *   GET /        → <h1>Example page</h1>       (recipe asserting "Example" passes)
 *   GET /other   → <h1>Other heading</h1>      (stale recipe fails: no "Example")
 * Usage: node scripts/test-site.mjs [port]   (default 8099)
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8099);
const pages = {
  "/": `<!DOCTYPE html><html><head><title>Example</title></head><body><h1>Example page</h1></body></html>`,
  "/other": `<!DOCTYPE html><html><head><title>Other</title></head><body><h1>Other heading</h1></body></html>`,
};

createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const html = pages[path] ?? pages["/"];
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(port, "127.0.0.1", () => {
  console.log(`test site on http://127.0.0.1:${port}`);
});

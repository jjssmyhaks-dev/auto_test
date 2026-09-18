import { createServer, type Server } from "node:http";

const PAGES: Record<string, string> = {
  "/": `<!DOCTYPE html><html><head><title>Acme Login</title></head><body>
    <h1>Acme sign in</h1>
    <form action="/login" method="post">
      <label for="email">Email</label> <input id="email" name="email" type="email" aria-label="Email" placeholder="you@example.com" />
      <label for="password">Password</label> <input id="password" name="password" type="password" aria-label="Password" />
      <button type="submit">Sign in</button>
    </form>
  </body></html>`,
  "/dashboard": `<!DOCTYPE html><html><head><title>Acme Dashboard</title></head><body>
    <h1>Dashboard</h1>
    <p>Welcome back, demo user.</p>
    <a id="cart-link" href="/cart">Open cart</a>
  </body></html>`,
  "/cart": `<!DOCTYPE html><html><head><title>Acme Cart</title></head><body>
    <h1>Your cart</h1>
    <ul id="cart-items"></ul>
    <form id="add-form" method="get" action="/cart">
      <input id="item-name" name="item" aria-label="Item name" placeholder="Item name" />
      <button type="submit">Add item</button>
    </form>
    <p id="cart-total">Total: $0.00</p>
    <a href="/dashboard">Back to dashboard</a>
    <script>
      const params = new URLSearchParams(location.search);
      const item = params.get("item");
      if (item) {
        const li = document.createElement("li");
        li.textContent = item + " - $9.99";
        li.setAttribute("data-item", item);
        document.getElementById("cart-items").appendChild(li);
        document.getElementById("cart-total").textContent = "Total: $9.99";
      }
    </script>
  </body></html>`,
  "/slow": `<!DOCTYPE html><html><head><title>Slow page</title></head><body>
    <h1>Eventually loads</h1>
    <script>await new Promise((r) => setTimeout(r, 700));</script>
  </body></html>`,
};

const REDIRECTS: Record<string, string> = {
  "/login": "/dashboard",
  "/add-item": "/cart",
};

/** Accepts the login POST form and lands on the dashboard. */
function handleLoginPost(body: string): string {
  // Credentials are parsed but never echoed anywhere — mirrors server-side redaction.
  void body;
  return PAGES["/dashboard"];
}

/** Deterministic local site for golden flows. No external network needed. */
export function startTestSite(port = 0): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && (req.url ?? "").split("?")[0] === "/login") {
        let body = "";
        req.on("data", (chunk) => (body += String(chunk)));
        req.on("end", () => {
          const page = handleLoginPost(body);
          res.writeHead(200, { "content-type": "text/html" });
          res.end(page);
        });
        return;
      }
      const path = (req.url ?? "/").split("?")[0];
      if (REDIRECTS[path]) {
        res.writeHead(302, { location: REDIRECTS[path] });
        res.end();
        return;
      }
      const page = PAGES[path];
      if (!page) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<!DOCTYPE html><html><body><h1>Not found</h1></body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page);
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const realPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        url: `http://127.0.0.1:${realPort}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

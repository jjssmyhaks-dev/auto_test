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
    <script>
      setTimeout(() => {
        const b = document.createElement("button");
        b.id = "late-button";
        b.textContent = "Finally loaded";
        document.body.appendChild(b);
      }, 250);
    </script>
  </body></html>`,
  "/checkout": `<!DOCTYPE html><html><head><title>Acme Checkout</title></head><body>
    <h1>Checkout</h1>
    <button id="pay-now" onclick="this.textContent='Paid'; document.getElementById('confirm').textContent='Order confirmed'">Pay now</button>
    <p id="confirm">Awaiting payment</p>
  </body></html>`,
  "/otp": `<!DOCTYPE html><html><head><title>Acme 2FA</title></head><body>
    <h1>Two-factor check</h1>
    <p id="otp-wait">Enter the code we texted you</p>
    <form action="/otp-verify" method="post">
      <input id="otp-code" name="code" aria-label="OTP code" inputmode="numeric" />
      <button type="submit">Verify code</button>
    </form>
  </body></html>`,
  "/otp-verify": `<!DOCTYPE html><html><head><title>Acme Verified</title></head><body>
    <h1>Identity confirmed</h1>
    <p>Welcome to your secure session.</p>
  </body></html>`,
  "/spa": `<!DOCTYPE html><html><head><title>Acme SPA</title></head><body>
    <h1 id="spa-title">Section: home</h1>
    <nav>
      <button id="tab-settings" onclick="document.getElementById('spa-title').textContent='Section: settings'">Settings</button>
      <button id="tab-billing" onclick="document.getElementById('spa-title').textContent='Section: billing'">Billing</button>
    </nav>
  </body></html>`,
  "/selects": `<!DOCTYPE html><html><head><title>Acme Prefs</title></head><body>
    <h1>Preferences</h1>
    <select id="region" aria-label="Region">
      <option value="eu">Europe</option>
      <option value="us">United States</option>
      <option value="apac">Asia Pacific</option>
    </select>
    <p id="plan">Plan: none</p>
    <a href="/dashboard">Dashboard</a>
  </body></html>`,
  "/long": `<!DOCTYPE html><html><head><title>Acme Docs</title></head><body>
    <h1>Documentation</h1>
    <div style="height:1500px"></div>
    <p id="footer-note">You reached the footer</p>
  </body></html>`,
};

const REDIRECTS: Record<string, string> = {
  "/login": "/dashboard",
  "/add-item": "/cart",
};

const POST_ROUTES: Record<string, (body: string) => { status: number; page: string }> = {
  "/login": () => ({ status: 200, page: PAGES["/dashboard"] }),
  "/otp-verify": (body) => {
    const code = new URLSearchParams(body).get("code") ?? "";
    // Any 6-digit code verifies; wrong shapes bounce back to the OTP gate.
    return /^\d{6}$/.test(code)
      ? { status: 200, page: PAGES["/otp-verify"] }
      : { status: 200, page: PAGES["/otp"] };
  },
};

/** Deterministic local site for golden flows. No external network needed. */
export function startTestSite(port = 0): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "POST") {
        const handler = POST_ROUTES[path];
        if (!handler) {
          res.writeHead(404, { "content-type": "text/html" });
          res.end("<!DOCTYPE html><html><body><h1>Not found</h1></body></html>");
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += String(chunk)));
        req.on("end", () => {
          const { page } = handler(body);
          res.writeHead(200, { "content-type": "text/html" });
          res.end(page);
        });
        return;
      }
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

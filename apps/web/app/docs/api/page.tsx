import { AppPage } from "@/components/app-page";

/**
 * Static API reference — mirrors the OpenAPI spec at /openapi.json on the API.
 * Kept as a hand-written table (not a generated one) so it can carry narrative
 * the raw spec can't; CI's api-smoke job keeps /openapi.json authoritative.
 */

const ENDPOINTS: Array<{ method: string; path: string; auth: string; blurb: string }> = [
  { method: "GET", path: "/health", auth: "none", blurb: "Liveness + configured integrations (postgres, s3, oidc, smtp, stripe)." },
  { method: "GET", path: "/openapi.json", auth: "none", blurb: "Machine-readable spec (source of truth)." },
  { method: "POST", path: "/v1/auth/signup", auth: "none", blurb: "Create an account (8+ char password, rate-limited 10/5min per IP)." },
  { method: "POST", path: "/v1/auth/login", auth: "none", blurb: "Email + password → session bearer token (or httpOnly cookie)." },
  { method: "GET", path: "/v1/auth/oidc/callback", auth: "none", blurb: "OIDC SSO callback (enterprise; VERIFLOW_OIDC_* envs)." },
  { method: "POST", path: "/v1/runs", auth: "session / API key", blurb: "Ingest a finished run (events, spans, evidence files). 402 past quota or cost cap." },
  { method: "GET", path: "/v1/runs/:id/trace", auth: "session", blurb: "Full trace: steps, spans, screenshots (data URIs), video link." },
  { method: "POST", path: "/v1/runs/:id/frames", auth: "session / API key", blurb: "Push a live frame (PNG base64) while a run executes." },
  { method: "GET", path: "/v1/runs/:id/stream", auth: "session", blurb: "SSE live stream of run frames (EventSource; replays recent frames)." },
  { method: "POST", path: "/v1/flows", auth: "session", blurb: "Create/update a flow — every distinct definition becomes an immutable version." },
  { method: "GET", path: "/v1/flows/:id/versions", auth: "session", blurb: "Version history with change hashes and last-green run links." },
  { method: "POST", path: "/v1/flows/:id/rollback", auth: "member+", blurb: "Copy an old version forward as a new version (history never rewritten)." },
  { method: "GET", path: "/v1/flows/:id/flake", auth: "viewer+", blurb: "Flake score (flip rate over recent runs), quarantine state, retry policy." },
  { method: "POST", path: "/v1/schedules/claim", auth: "session / API key", blurb: "Claim due scheduled flows exactly-once per minute (cron/GitHub Actions)." },
  { method: "GET", path: "/v1/webhooks", auth: "viewer+", blurb: "Outbound webhook endpoints (secrets never listed back)." },
  { method: "POST", path: "/v1/webhooks", auth: "admin+", blurb: "Create a webhook; the signing secret is shown exactly once." },
  { method: "POST", path: "/v1/webhooks/test", auth: "member+", blurb: "Test-fire signed deliveries to every enabled endpoint." },
  { method: "GET", path: "/v1/audit", auth: "viewer+", blurb: "Append-only audit trail: flow edits, rollbacks, member changes, purges." },
  { method: "POST", path: "/v1/retention/purge", auth: "admin+", blurb: "Delete runs/evidence older than the tier retention window (7/30/90 days)." },
  { method: "POST", path: "/v1/settings/cost-cap", auth: "session", blurb: "Set/clear the monthly USD cost cap (runs 402 past it)." },
  { method: "POST", path: "/v1/redteam", auth: "session / API key", blurb: "Run the red-team probe bank against a chat endpoint." },
  { method: "POST", path: "/v1/agent-tests", auth: "session / API key", blurb: "Run the agent scenario suite against a chat endpoint." },
];

export const metadata = { title: "Veriflow — API reference" };

export default function ApiDocsPage() {
  return (
    <AppPage
      kicker="Docs · API"
      title="Everything is a documented endpoint."
      hint={{
        steps: [
          "Auth is a bearer session token or a project API key (x-api-key); cookie sessions need the x-veriflow-csrf header on writes.",
          "The machine-readable spec is always at /openapi.json on the API host — this page is the annotated tour.",
          "Webhooks are signed HMAC-SHA256 over `t.<body>`; verify before trusting (same scheme as Stripe).",
        ],
        cli: "npx veriflow login",
      }}
    >
      <p className="empty">
        Base URL: <code>{process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787"}</code> — the official TypeScript client
        is <code>@veriflow/sdk</code> (packages/sdk): <code>new Veriflow(&#123; apiUrl, token &#125;)</code>.
      </p>
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Auth</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {ENDPOINTS.map((e) => (
            <tr key={`${e.method} ${e.path}`}>
              <td className="font-mono text-[10px] font-bold">{e.method}</td>
              <td className="font-mono text-[10px]">{e.path}</td>
              <td className="whitespace-nowrap text-[10px] uppercase">{e.auth}</td>
              <td>{e.blurb}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </AppPage>
  );
}

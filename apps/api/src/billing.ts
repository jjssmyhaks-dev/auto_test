import { TIER_QUOTAS, type BillingTier } from "@veriflow/schema";
import type { CloudStore } from "./store.js";

/**
 * Stripe billing reconciliation.
 *
 * Tier flips ride on `checkout.session.completed` webhooks, which are
 * best-effort delivery: if Stripe fails to reach us (or the webhook 500s
 * during a deploy), the user pays but stays on the free tier with no way to
 * self-recover. This module sweeps Stripe for paid Checkout Sessions and
 * heals the missed tier flip. Same trust direction as the webhook: metadata
 * (userId + tier) only ever *upgrades* — a reconcile can never downgrade.
 */

export interface StripeCheckoutSession {
  id: string;
  status?: string;
  payment_status?: string;
  metadata?: { userId?: string; tier?: string };
}

export interface ReconcileReport {
  /** Paid completed sessions examined. */
  checked: number;
  /** Tier flips applied (the missed-webhook heal). */
  healed: Array<{ userId: string; tier: BillingTier }>;
  skipped?: string;
}

const TIER_RANK: Record<string, number> = { free: 0, starter: 1, team: 2 };

/** List completed Checkout Sessions created within the window, paid only. */
export async function listPaidCheckoutSessions(
  fetchImpl: typeof fetch,
  secretKey: string,
  windowHours: number,
): Promise<StripeCheckoutSession[]> {
  const created = Math.floor(Date.now() / 1000) - Math.round(windowHours * 3600);
  const res = await fetchImpl(
    `https://api.stripe.com/v1/checkout/sessions?status=completed&limit=100&created%5Bgt%5D=${created}`,
    { headers: { authorization: `Bearer ${secretKey}` } },
  );
  if (!res.ok) throw new Error(`stripe list sessions failed (${res.status})`);
  const data = (await res.json()) as { data?: StripeCheckoutSession[] };
  return (data.data ?? []).filter(
    (s) =>
      s.payment_status === "paid" &&
      Boolean(s.metadata?.userId) &&
      Boolean(s.metadata?.tier && TIER_QUOTAS[s.metadata.tier as BillingTier]),
  );
}

/**
 * Sweep recent paid sessions and heal tiers. `onlyUserId` limits the heal to
 * one user (self-service); admins omit it to sweep everyone.
 */
export async function reconcileStripeBilling(
  store: Pick<CloudStore, "getUser" | "setTier">,
  opts: { fetchImpl?: typeof fetch; windowHours?: number; onlyUserId?: string } = {},
): Promise<ReconcileReport> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return { checked: 0, healed: [], skipped: "stripe not configured" };
  const sessions = await listPaidCheckoutSessions(opts.fetchImpl ?? fetch, secretKey, opts.windowHours ?? 168);
  const healed: Array<{ userId: string; tier: BillingTier }> = [];
  for (const session of sessions) {
    const userId = session.metadata!.userId!;
    const tier = session.metadata!.tier as BillingTier;
    if (opts.onlyUserId && userId !== opts.onlyUserId) continue;
    const user = await store.getUser(userId);
    if (!user) continue; // webhook metadata for a since-deleted user
    if ((TIER_RANK[tier] ?? 0) <= (TIER_RANK[user.tier] ?? 0)) continue; // never downgrade
    await store.setTier(userId, tier);
    healed.push({ userId, tier });
  }
  return { checked: sessions.length, healed };
}

/**
 * Periodic self-heal. Runs only when STRIPE_SECRET_KEY is set; interval via
 * VERIFLOW_BILLING_RECONCILE_MINUTES (default 30). Unref'd so it never holds
 * the process open.
 */
export function startBillingReconciler(
  store: Pick<CloudStore, "getUser" | "setTier">,
  deps: { fetchImpl?: typeof fetch } = {},
  log: (msg: string) => void = (m) => console.error(m),
): NodeJS.Timeout | undefined {
  const minutes = Number(process.env.VERIFLOW_BILLING_RECONCILE_MINUTES ?? 30);
  if (!process.env.STRIPE_SECRET_KEY || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  const timer = setInterval(() => {
    reconcileStripeBilling(store, deps)
      .then((r) => {
        if (r.healed.length > 0) log(`billing reconcile healed ${r.healed.length} missed tier flip(s)`);
      })
      .catch((err) => log(`billing reconcile failed: ${err instanceof Error ? err.message : err}`));
  }, minutes * 60_000);
  timer.unref?.();
  return timer;
}

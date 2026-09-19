"use client";

import { FormEvent, useState } from "react";
import { api, setToken } from "@/lib/api";
import { useRouter } from "next/navigation";
import { AppPage } from "@/components/app-page";
import { syncOnboardingFromAccount } from "@/lib/onboarding";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("dev@local.test");
  const [password, setPassword] = useState("password1");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Invites land as /login?invite=<token> — accept it right after auth.
  const inviteToken = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("invite") : null;
  const [invited, setInvited] = useState<string | null>(null);

  async function submit(path: "/v1/auth/login" | "/v1/auth/signup", e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>(path, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(res.token);
      // Pull this account's onboarding/tour progress so it follows the user
      // across devices; union with anything done locally before sign-in.
      void syncOnboardingFromAccount();
      if (inviteToken) {
        try {
          const acc = await api<{ projectId: string; role: string }>("/v1/invites/accept", {
            method: "POST",
            body: JSON.stringify({ token: inviteToken }),
          });
          setInvited(`Joined project ${acc.projectId} as ${acc.role}.`);
          history.replaceState(null, "", window.location.pathname);
        } catch (inviteErr) {
          setInvited(inviteErr instanceof Error ? inviteErr.message : "Invite could not be accepted.");
        }
      }
      router.push("/runs");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppPage kicker="Account" title="Sign in to sync evidence.">
      {inviteToken ? (
        <p className="empty">You've been invited to a team project — sign in or sign up to join it.</p>
      ) : null}
      <form className="stack">
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        </label>
        <label>
          Password
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
        </label>
        {error ? <p className="error">{error}</p> : null}
        {invited ? <p className="empty">{invited}</p> : null}
        <div className="row">
          <button disabled={busy} onClick={(e) => submit("/v1/auth/login", e)}>
            Log in
          </button>
          <button disabled={busy} className="secondary" onClick={(e) => submit("/v1/auth/signup", e)}>
            Sign up
          </button>
        </div>
      </form>
    </AppPage>
  );
}

"use client";

import { FormEvent, useState } from "react";
import { api, setToken } from "@/lib/api";
import { useRouter } from "next/navigation";
import { AppPage } from "@/components/app-page";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("dev@local.test");
  const [password, setPassword] = useState("password1");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      router.push("/runs");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppPage kicker="Account" title="Sign in to sync evidence.">
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

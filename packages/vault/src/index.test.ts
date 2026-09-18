import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Vault, loadCredentials, redactDeep, redactSecrets, saveCredentials } from "./index.js";

describe("redactSecrets", () => {
  it("masks secrets before LLM/storage payloads", () => {
    const secrets = ["super-secret-token-xyz"];
    expect(redactSecrets("Authorization: super-secret-token-xyz", secrets)).toBe(
      "Authorization: [REDACTED]",
    );
    expect(
      redactDeep(
        { type: "fill", secret: true, vaultKey: "pw", value: "hunter2-long" },
        ["hunter2-long"],
      ),
    ).toEqual({ type: "fill", secret: true, vaultKey: "pw", value: "[REDACTED]" });
  });

  it("skips tiny fragments to avoid over-redaction", () => {
    expect(redactSecrets("a cat sat", ["a", "cat"])).toBe("a cat sat");
  });
});

describe("Vault AES-256-GCM", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("round-trips secrets", () => {
    const home = mkdtempSync(join(tmpdir(), "veriflow-vault-"));
    dirs.push(home);
    const vault = new Vault(home);
    vault.set("login.password", "s3cret-value-ok");
    expect(vault.get("login.password")).toBe("s3cret-value-ok");
    expect(vault.keys()).toEqual(["login.password"]);
    expect(vault.secretValues()).toEqual(["s3cret-value-ok"]);
  });

  it("encrypts cloud credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "veriflow-creds-"));
    dirs.push(home);
    saveCredentials(
      { apiUrl: "http://127.0.0.1:8787", token: "sess_abc", email: "a@b.c", apiKey: "vf_secret" },
      home,
    );
    const loaded = loadCredentials(home);
    expect(loaded?.token).toBe("sess_abc");
    expect(loaded?.apiKey).toBe("vf_secret");
  });
});

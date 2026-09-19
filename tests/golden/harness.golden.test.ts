import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runHarness } from "@veriflow/harness";
import { readEvents, readSpans, runPaths } from "@veriflow/store";
import { startTestSite } from "./test-site.js";
import { refFor, scriptedProvider, type ScriptStep } from "./scripted-llm.js";

const site = await startTestSite();

afterAll(async () => {
  await site.close();
});

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "vf-golden-"));
}

/** Helper: scripted fill via an a11y ref matched from the observation. */
const fill = (label: string, value: string, secret = false): ScriptStep => (input) => ({
  type: "fill",
  target: { ref: refFor(input, label) },
  value,
  secret,
});

const click = (label: string, destructive = false): ScriptStep => (input) => ({
  type: "click",
  target: { ref: refFor(input, label) },
  destructive,
});

const assertHeading = (text: string): ScriptStep => ({ type: "assert", check: "heading_contains", value: text });
const assertText = (text: string): ScriptStep => ({ type: "assert", check: "text_contains", value: text });
const assertUrl = (fragment: string): ScriptStep => ({ type: "assert", check: "url_contains", value: fragment });
const done = (reason = "flow complete"): ScriptStep => ({ type: "finish", success: true, reason });
const fail = (reason: string): ScriptStep => ({ type: "finish", success: false, reason });

const loginSteps = (): ScriptStep[] => [
  fill("Email", "demo@acme.test"),
  fill("Password", "hunter2", true),
  click("Sign in"),
];

describe("golden flows — auth & navigation (spec 1.8)", () => {
  it("01 logs in and asserts the dashboard heading", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "log in with demo@acme.test and assert the dashboard heading",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider([...loginSteps(), assertHeading("Dashboard"), done()]),
      record: true,
    });
    expect(result.status).toBe("passed");
    expect(result.evidencePath ? existsSync(result.evidencePath) : false).toBe(true);
    expect(result.reportPath ? existsSync(result.reportPath) : false).toBe(true);
  }, 60_000);

  it("02 navigates dashboard → cart and back", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "open the cart and return to the dashboard",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider([...loginSteps(), click("Open cart"), assertText("Your cart"), click("Back to dashboard"), assertHeading("Dashboard"), done()]),
    });
    expect(result.status).toBe("passed");
  }, 60_000);

  it("03 navigates directly to a deep URL", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "open the checkout page directly",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider([{ type: "navigate", url: `${site.url}/checkout` }, assertHeading("Checkout"), done()]),
    });
    expect(result.status).toBe("passed");
  }, 60_000);

  it("04 handles SPA tab switches without full navigation", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "switch to the settings tab in the SPA",
      envUrl: `${site.url}/spa`,
      headless: true,
      home,
      provider: scriptedProvider([click("Settings"), assertText("Section: settings"), click("Billing"), assertText("Section: billing"), done()]),
    });
    expect(result.status).toBe("passed");
  }, 60_000);

  it("05 waits for a late-rendering element", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "wait for the slow element to appear",
      envUrl: `${site.url}/slow`,
      headless: true,
      home,
      provider: scriptedProvider([{ type: "wait", selector: "#late-button", ms: 3000 }, assertText("Finally loaded"), done()]),
    });
    expect(result.status).toBe("passed");
  }, 60_000);

  it("06 fills a select dropdown", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "choose the United States region",
      envUrl: `${site.url}/selects`,
      headless: true,
      home,
      provider: scriptedProvider([{ type: "select", target: { ref: "region" }, value: "us" }, assertText("Plan: none"), done()]),
    });
    expect(result.status).toBe("passed");
  }, 60_000);

  it("07 scrolls a long page to the footer", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "scroll to the bottom of the docs",
      envUrl: `${site.url}/long`,
      headless: true,
      home,
      provider: scriptedProvider([{ type: "scroll", direction: "down", amount: 1600 }, { type: "wait", ms: 300 }, assertText("You reached the footer"), done()]),
    });
    expect(result.status).toBe("passed");
  }, 60_000);
});

describe("golden flows — forms & assertions", () => {
  it("08 adds a cart item and asserts the total", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "add Widget to the cart and assert the total",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider([...loginSteps(), click("Open cart"), fill("Item name", "Widget"), click("Add item"), assertText("Total: $9.99"), done()]),
    });
    expect(result.status).toBe("passed");
    const events = readEvents(result.runId, home);
    const acts = events.filter((e) => e.type === "act" && (e.payload as { ok?: boolean }).ok === true);
    expect(acts.length).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("09 asserts URL after navigation", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "reach the cart page and verify the url",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider([...loginSteps(), click("Open cart"), assertUrl("/cart"), done()]),
    });
    expect(result.status).toBe("passed");
  }, 60_000);

  it("10 multi-field form flow (login → cart add → checkout pay)", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "log in, add an item, and pay",
      envUrl: site.url,
      headless: true,
      home,
      yesIMeanIt: true,
      provider: scriptedProvider([...loginSteps(), click("Open cart"), fill("Item name", "Gizmo"), click("Add item"), { type: "navigate", url: `${site.url}/checkout` }, click("Pay now"), assertText("Order confirmed"), done()]),
    });
    expect(result.status).toBe("passed");
  }, 60_000);
});

describe("golden flows — secrets & evidence", () => {
  it("11 fills marked secrets but keeps them out of stored events", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "log in and assert dashboard",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider([...loginSteps(), assertHeading("Dashboard"), done()]),
    });
    expect(result.status).toBe("passed");
    const raw = JSON.stringify(readEvents(result.runId, home));
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("[REDACTED]");
  }, 60_000);

  it("12 writes screenshots and spans for every step", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "log in",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider([...loginSteps(), done()]),
    });
    const rp = runPaths(result.runId, home);
    expect(existsSync(join(rp.screenshots, "step-0.png"))).toBe(true);
    const spans = readSpans(result.runId, home);
    expect(spans.some((s) => s.kind === "OBSERVE" && s.attributes?.stepIndex === 0)).toBe(true);
    expect(spans.some((s) => s.kind === "DECIDE" && s.attributes?.stepIndex === 0)).toBe(true);
    expect(spans.some((s) => s.kind === "VERIFY")).toBe(true);
  }, 60_000);

  it("13 dry-run mode skips the browser ACT but records guards", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "dry-run the login",
      envUrl: site.url,
      headless: true,
      home,
      dryRun: true,
      provider: scriptedProvider([...loginSteps(), done()]),
    });
    expect(result.status).toBe("passed");
    const events = readEvents(result.runId, home);
    const acts = events.filter((e) => e.type === "act");
    expect(acts.every((e) => (e.payload as { dryRun?: boolean }).dryRun === true)).toBe(true);
  }, 60_000);
});

describe("golden flows — guardrails", () => {
  it("14 blocks a destructive click without --yes-i-mean-it", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "pay now without confirmation",
      envUrl: `${site.url}/checkout`,
      headless: true,
      home,
      yesIMeanIt: false,
      provider: scriptedProvider([click("Pay now"), done()]),
    });
    expect(result.status).toBe("aborted");
    expect(result.error).toMatch(/destructive/i);
  }, 60_000);

  it("15 allows the same click with --yes-i-mean-it", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "pay now with confirmation",
      envUrl: `${site.url}/checkout`,
      headless: true,
      home,
      yesIMeanIt: true,
      provider: scriptedProvider([click("Pay now"), assertText("Order confirmed"), done()]),
    });
    expect(result.status).toBe("passed");
  }, 60_000);

  it("16 aborts on an action loop (same action repeated)", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "click the same harmless link repeatedly",
      envUrl: `${site.url}/selects`,
      headless: true,
      home,
      stepCap: 20,
      provider: scriptedProvider([click("Dashboard"), click("Dashboard"), click("Dashboard")]),
    });
    expect(result.status).toBe("aborted");
    expect(result.error).toMatch(/repeated/i);
  }, 60_000);

  it("17 reports an honest failure when an assertion cannot pass", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "assert a heading that does not exist",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider([assertHeading("This Heading Never Exists"), done()]),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/assert failed/i);
  }, 60_000);

  it("18 finish(success:false) marks the run failed with the model's reason", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "give up immediately",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider([fail("page is not in a testable state")]),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("page is not in a testable state");
  }, 60_000);
});

describe("golden flows — human-in-the-loop & self-heal (spec 1.5/1.4)", () => {
  it("19 pauses on request_human (OTP) and resumes after the code is entered", async () => {
    const home = newHome();
    const prompts: string[] = [];
    const result = await runHarness({
      objective: "complete the 2FA challenge",
      envUrl: `${site.url}/otp`,
      headless: true,
      home,
      provider: scriptedProvider([
        // The model sees the 2FA gate and asks the human to enter the code.
        { type: "request_human", reason: "otp", prompt: "Enter the SMS code in the opened browser window, then press Enter here." },
        fill("OTP code", "123456"),
        click("Verify code"),
        assertHeading("Identity confirmed"),
        done("otp flow complete"),
      ]),
      pause: async (prompt) => {
        prompts.push(prompt);
        return "code entered manually by the human";
      },
    });
    expect(result.status).toBe("passed");
    expect(prompts.length).toBe(1);
    const events = readEvents(result.runId, home);
    expect(events.some((e) => e.type === "human")).toBe(true);
    const spans = readSpans(result.runId, home);
    expect(spans.some((s) => s.kind === "HUMAN")).toBe(true);
  }, 60_000);

  it("20 self-heals: re-observes and retries a failed action until it succeeds", async () => {
    const home = newHome();
    const steps: ScriptStep[] = [
      ...loginSteps(),
      // Post-login the model emits a ref that no longer exists in the fresh
      // observation — strict ref resolution throws, the harness re-observes,
      // re-decides with the failure in context, and the retry succeeds.
      () => ({ type: "click", target: { ref: "e99" } }),
      (input) => ({ type: "click", target: { ref: refFor(input, "Open cart") } }),
      assertText("Your cart"),
      done("recovered after stale ref"),
    ];
    const result = await runHarness({
      objective: "open the cart (with a stale first click)",
      envUrl: site.url,
      headless: true,
      home,
      provider: scriptedProvider(steps),
    });
    expect(result.status).toBe("passed");
    const events = readEvents(result.runId, home);
    const retries = events.filter((e) => e.type === "retry");
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(retries.some((e) => (e.payload as { ok?: boolean }).ok === true)).toBe(true);
    const spans = readSpans(result.runId, home);
    // The healed attempt is a full DECIDE→ACT cycle marked healing:true (spec 1.5).
    expect(spans.some((s) => s.kind === "DECIDE" && (s.attributes as { healing?: boolean } | undefined)?.healing === true)).toBe(true);
    expect(spans.some((s) => s.kind === "ACT" && (s.attributes as { healing?: boolean } | undefined)?.healing === true && s.ok === true)).toBe(true);
  }, 60_000);
});

describe("golden flows — devtools & page-state assertions (spec 6.4)", () => {
  it("21 asserts cookies and localStorage after a state-setting page", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "visit /state and verify the session cookie and theme preference are saved",
      envUrl: `${site.url}/state`,
      headless: true,
      home,
      provider: scriptedProvider([
        { type: "assert", check: "cookie_contains", value: "session" },
        { type: "assert", check: "local_storage", value: "theme" },
        done("cookie and storage verified"),
      ]),
    });
    expect(result.status).toBe("passed");
    const events = readEvents(result.runId, home);
    const asserts = events.filter((e) => e.type === "verify" && e.payload.finish !== true);
    expect(asserts.length).toBe(2);
    expect(asserts.every((e) => (e.payload as { ok?: boolean }).ok === true)).toBe(true);
    expect(asserts.some((e) => (e.payload as { detail?: string }).detail?.includes("cookie session"))).toBe(true);
  }, 60_000);

  it("22 asserts page load time under a generous budget", async () => {
    const home = newHome();
    const result = await runHarness({
      objective: "verify the dashboard loads fast",
      envUrl: `${site.url}/dashboard`,
      headless: true,
      home,
      provider: scriptedProvider([
        { type: "assert", check: "load_time_under", value: "5000" },
        done("load time within budget"),
      ]),
    });
    expect(result.status).toBe("passed");
    const events = readEvents(result.runId, home);
    const verify = events.find((e) => e.type === "verify");
    expect((verify?.payload as { detail?: string }).detail).toMatch(/load took \d+ms/);
  }, 60_000);
});

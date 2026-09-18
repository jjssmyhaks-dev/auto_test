import type { Action, RunEvent } from "@veriflow/schema";

export function actionsFromEvents(events: RunEvent[]): Action[] {
  const out: Action[] = [];
  for (const event of events) {
    if (event.type !== "decide" && event.type !== "act") continue;
    const action = event.payload.action as Action | undefined;
    if (action && typeof action === "object" && "type" in action) {
      if (event.type === "decide") out.push(action);
    }
  }
  return out;
}

export function exportPlaywrightTest(input: {
  name: string;
  objective: string;
  actions: Action[];
  envUrl?: string;
}): string {
  const lines: string[] = [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `test(${JSON.stringify(input.name)}, async ({ page }) => {`,
  ];
  if (input.envUrl) {
    lines.push(`  await page.goto(${JSON.stringify(input.envUrl)});`);
  }
  lines.push(`  // Objective: ${input.objective.replace(/\*\//g, "")}`);
  for (const action of input.actions) {
    lines.push(...actionToPlaywright(action).map((l) => `  ${l}`));
  }
  lines.push(`});`, ``);
  return lines.join("\n");
}

function loc(action: { target?: { selector?: string; text?: string; ref?: string } }): string {
  const t = action.target;
  if (t?.selector) return `page.locator(${JSON.stringify(t.selector)}).first()`;
  if (t?.text) return `page.getByText(${JSON.stringify(t.text)}).first()`;
  return `page.locator("body")`;
}

function actionToPlaywright(action: Action): string[] {
  switch (action.type) {
    case "navigate":
      return [`await page.goto(${JSON.stringify(action.url)});`];
    case "click":
      return [`await ${loc(action)}.click();`];
    case "fill":
      return [
        action.secret || action.vaultKey
          ? `await ${loc(action)}.fill(process.env[${JSON.stringify(action.vaultKey ?? "SECRET")}] ?? "");`
          : `await ${loc(action)}.fill(${JSON.stringify(action.value)});`,
      ];
    case "select":
      return [`await ${loc(action)}.selectOption(${JSON.stringify(action.value)});`];
    case "hover":
      return [`await ${loc(action)}.hover();`];
    case "scroll":
      return [`await page.mouse.wheel(0, ${action.direction === "up" ? -400 : 400});`];
    case "wait":
      return action.selector
        ? [`await page.waitForSelector(${JSON.stringify(action.selector)});`]
        : [`await page.waitForTimeout(${action.ms ?? 500});`];
    case "assert": {
      if (action.check === "url_contains") {
        return [`await expect(page).toHaveURL(/${escapeRegex(action.value ?? "")}/);`];
      }
      if (action.check === "heading_contains") {
        return [`await expect(page.locator("h1,h2,h3").first()).toContainText(${JSON.stringify(action.value ?? "")});`];
      }
      if (action.check === "text_contains") {
        return [`await expect(page.locator("body")).toContainText(${JSON.stringify(action.value ?? "")});`];
      }
      if (action.check === "visible" && action.target?.selector) {
        return [`await expect(page.locator(${JSON.stringify(action.target.selector)}).first()).toBeVisible();`];
      }
      return [`// assert ${action.check} ${action.value ?? ""}`];
    }
    case "finish":
      return [`// finish success=${action.success} ${JSON.stringify(action.reason)}`];
    default:
      return [`// skipped ${action.type}`];
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Best-effort Playwright → Veriflow flow.
 * Limits: no fixtures, no custom helpers, no locators beyond page.goto/click/fill/getByText/expect.
 */
export function importPlaywrightTest(source: string): { name: string; objective: string; envUrl?: string; actions: Action[] } {
  const nameMatch = source.match(/test\((['"`])([^'"`]+)\1/);
  const name = nameMatch?.[2] ?? "imported-playwright";
  const actions: Action[] = [];
  let envUrl: string | undefined;
  const goto = [...source.matchAll(/page\.goto\((['"`])([^'"`]+)\1\)/g)];
  for (const m of goto) {
    envUrl ??= m[2];
    actions.push({ type: "navigate", url: m[2] });
  }
  for (const m of source.matchAll(/page\.(?:locator|getByRole|getByText)\(([^)]+)\)(?:\.first\(\))?\.click\(/g)) {
    const inner = m[1].trim();
    const text = inner.match(/['"`]([^'"`]+)['"`]/);
    actions.push({ type: "click", target: { text: text?.[1], selector: inner.includes("locator") ? text?.[1] : undefined } });
  }
  for (const m of source.matchAll(/\.fill\((['"`])([^'"`]*)\1\)/g)) {
    actions.push({ type: "fill", target: { selector: "input" }, value: m[2] });
  }
  for (const m of source.matchAll(/toContainText\((['"`])([^'"`]+)\1\)/g)) {
    actions.push({ type: "assert", check: "text_contains", value: m[2] });
  }
  for (const m of source.matchAll(/toHaveURL\((?:\/(.*?)\/|(['"`])([^'"`]+)\2)\)/g)) {
    actions.push({ type: "assert", check: "url_contains", value: m[1] ?? m[3] ?? "" });
  }
  actions.push({ type: "finish", success: true, reason: "imported playwright sequence complete" });
  return {
    name,
    objective: `Replay imported Playwright test: ${name}`,
    envUrl,
    actions,
  };
}

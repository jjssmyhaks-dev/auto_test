import type { Page } from "playwright";
import type { Action, Target } from "@veriflow/schema";
import { compactTree, type A11yNode, type A11ySnapshot } from "./a11y.js";
import { assertConsole, assertNetwork, assertPageState, type DevtoolsCapture } from "./devtools.js";

export async function observePage(page: Page): Promise<{
  url: string;
  screenshotPng: Buffer;
  a11y: A11ySnapshot;
}> {
  const screenshotPng = Buffer.from(await page.screenshot({ type: "png", fullPage: false }));
  const nodes = (await page.evaluate(() => {
    const interesting = [
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "h1",
      "h2",
      "h3",
      "[role='button']",
      "[role='link']",
      "[role='textbox']",
    ];
    const els = Array.from(document.querySelectorAll(interesting.join(",")));
    const seen = new Set<Element>();
    const out: Array<{
      ref: string;
      role: string;
      name: string;
      selector: string;
      bbox?: { x: number; y: number; width: number; height: number };
    }> = [];
    let i = 1;
    const cssPath = (el: Element): string => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && parts.length < 5) {
        const tag = node.tagName.toLowerCase();
        const parent: Element | null = node.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        const idx = siblings.indexOf(node) + 1;
        parts.unshift(`${tag}:nth-of-type(${idx})`);
        node = parent;
      }
      return parts.join(" > ");
    };
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      const role =
        el.getAttribute("role") ||
        (el.tagName === "A" ? "link" : el.tagName.toLowerCase());
      // Never expose typed values for password fields — only labels/placeholders.
      const safeValue = el instanceof HTMLInputElement && el.type === "password" ? "" : (el as HTMLInputElement).value;
      const name =
        (el.getAttribute("aria-label") ||
          (el as HTMLInputElement).placeholder ||
          el.textContent ||
          safeValue ||
          "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
      out.push({
        ref: `e${i++}`,
        role,
        name,
        selector: cssPath(el),
        bbox:
          rect.width && rect.height
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : undefined,
      });
    }
    return out;
  })) as A11yNode[];

  return {
    url: page.url(),
    screenshotPng,
    a11y: { nodes, tree: compactTree(nodes) },
  };
}

async function locatorFor(page: Page, target: Target | undefined, nodes: A11yNode[]) {
  if (!target) return page.locator("body");
  if (target.ref) {
    const ref = target.ref.replace(/^@/, "");
    const node = nodes.find((n) => n.ref === target.ref || n.ref === ref);
    // Strict ref resolution: an unresolvable ref means the page drifted from the
    // observation — fail fast so the harness re-observes and retries (self-heal),
    // instead of silently clicking <body>.
    if (!node?.selector) throw new Error(`target ref ${target.ref} not found in current observation`);
    return page.locator(node.selector).first();
  }
  if (target.selector) return page.locator(target.selector).first();
  if (target.text) return page.getByText(target.text, { exact: false }).first();
  if (target.bbox) {
    return null;
  }
  return page.locator("body");
}

export async function performAction(
  page: Page,
  action: Action,
  nodes: A11yNode[],
  resolveSecret: (action: Action) => string | undefined,
): Promise<{ ok: boolean; detail: string }> {
  switch (action.type) {
    case "navigate": {
      await page.goto(action.url, { waitUntil: "domcontentloaded" });
      return { ok: true, detail: `navigated ${action.url}` };
    }
    case "click": {
      const loc = await locatorFor(page, action.target, nodes);
      if (loc) await loc.click({ timeout: 8_000 });
      else if (action.target.bbox) {
        const b = action.target.bbox;
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      } else {
        throw new Error("click target not found");
      }
      return { ok: true, detail: "clicked" };
    }
    case "fill": {
      const loc = await locatorFor(page, action.target, nodes);
      const value = resolveSecret(action) ?? action.value;
      if (!loc) throw new Error("fill target not found");
      await loc.fill(value, { timeout: 8_000 });
      return { ok: true, detail: "filled" };
    }
    case "select": {
      const loc = await locatorFor(page, action.target, nodes);
      if (!loc) throw new Error("select target not found");
      await loc.selectOption(action.value, { timeout: 8_000 });
      return { ok: true, detail: "selected" };
    }
    case "hover": {
      const loc = await locatorFor(page, action.target, nodes);
      if (!loc) throw new Error("hover target not found");
      await loc.hover({ timeout: 8_000 });
      return { ok: true, detail: "hovered" };
    }
    case "scroll": {
      const amount = action.amount ?? 400;
      const dy = action.direction === "up" ? -amount : amount;
      const dx = action.direction === "left" ? -amount : action.direction === "right" ? amount : 0;
      await page.mouse.wheel(dx, action.direction === "left" || action.direction === "right" ? 0 : dy);
      return { ok: true, detail: "scrolled" };
    }
    case "wait": {
      if (action.selector) await page.waitForSelector(action.selector, { timeout: action.ms ?? 10_000 });
      else await page.waitForTimeout(action.ms ?? 500);
      return { ok: true, detail: "waited" };
    }
    case "assert":
    case "finish":
    case "request_human":
      return { ok: true, detail: action.type };
    default:
      return { ok: false, detail: "unknown" };
  }
}

export async function verifyAction(
  page: Page,
  action: Action,
  capture?: DevtoolsCapture,
): Promise<{ ok: boolean; detail: string }> {
  if (action.type !== "assert") {
    return { ok: true, detail: "n/a" };
  }
  const value = action.value ?? "";
  switch (action.check) {
    case "url_contains": {
      const ok = page.url().includes(value);
      return { ok, detail: `url ${page.url()}` };
    }
    case "heading_contains": {
      const headings = await page.locator("h1,h2,h3").allTextContents();
      const ok = headings.some((h) => h.toLowerCase().includes(value.toLowerCase()));
      return { ok, detail: headings.join(" | ") };
    }
    case "text_contains": {
      const body = await page.locator("body").innerText();
      const ok = body.toLowerCase().includes(value.toLowerCase());
      return { ok, detail: ok ? "found" : "missing" };
    }
    case "visible": {
      if (action.target?.selector) {
        const vis = await page.locator(action.target.selector).first().isVisible();
        return { ok: vis, detail: vis ? "visible" : "hidden" };
      }
      if (action.target?.text) {
        const vis = await page.getByText(action.target.text).first().isVisible();
        return { ok: vis, detail: vis ? "visible" : "hidden" };
      }
      return { ok: false, detail: "no target" };
    }
    case "network": {
      if (!capture) return { ok: false, detail: "devtools capture disabled (pass --devtools)" };
      return assertNetwork(capture, value);
    }
    case "console": {
      if (!capture) return { ok: false, detail: "devtools capture disabled (pass --devtools)" };
      return assertConsole(capture, value);
    }
    case "cookie_contains":
    case "local_storage":
    case "load_time_under":
      return assertPageState(page, action.check, value);
    default:
      return { ok: false, detail: "unknown assert" };
  }
}

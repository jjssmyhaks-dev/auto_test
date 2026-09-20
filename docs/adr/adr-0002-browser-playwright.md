# ADR 0002: Browser execution — Playwright

## Context

Browser automation underpins the OBSERVE→DECIDE→ACT loop. The proposal named
Playwright as the only real choice, citing CDP access and multi-browser
support. The harness already uses Playwright (Chromium today).

## Decision

Keep Playwright. Chromium remains the default browser.

## Consequences

- CDP is load-bearing: the DevTools-assertion feature (`devtools` probes:
  console errors, failed requests, performance timings) reads the protocol
  directly. Puppeteer offers CDP too but weaker automation ergonomics;
  Selenium offers neither cleanly.
- Cross-browser is a stated product gap (Firefox/WebKit). Playwright gives us
  those for free when switched on — the harness's browser launch is already
  parameterized; only the evidence pipeline and golden suite assume Chromium.
- `recordVideo` (shipped 2026-09) is a Playwright-native feature; rolling our
  own screencast via CDP frames would be significantly more work.
- Cost of leaving: very high — the loop, assertions, video, and evidence
  pipeline all speak Playwright APIs. Leaving was never on the table; this
  ADR records why.

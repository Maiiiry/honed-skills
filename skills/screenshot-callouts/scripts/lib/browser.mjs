// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// One way to get a browser. A fresh, launched, profile-less browser is the default: it holds no
// cookies, so a render page can never see a signed-in session. Attaching over CDP is explicit
// (--cdp), always opens a NEW tab, never one of the user's, and does so in a fresh context unless
// the caller asks for the signed-in one.

import { missingDep } from "./errors.mjs";

export async function launch({ channel, headless = true } = {}) {
  const { chromium } = await import("playwright-core");
  const tried = [];
  for (const ch of channel ? [channel] : ["chrome", "msedge", undefined]) {
    try {
      return await chromium.launch({ channel: ch, headless });
    } catch (e) {
      tried.push(`${ch ?? "bundled chromium"}: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw missingDep("BROWSER_MISSING", "no Chromium-family browser could be launched", {
    candidates: tried,
    fix: process.platform === "linux" ? "run: npx -y playwright-core@1.64.1 install --with-deps chromium" : "install Google Chrome or Microsoft Edge, or run: npx -y playwright-core@1.64.1 install chromium",
  });
}

export async function attach(cdpUrl, { signedIn = false, viewport, dpr, colorScheme } = {}) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(cdpUrl);
  if (signedIn && browser.contexts()[0]) return { browser, context: browser.contexts()[0], attached: true, signedIn: true };
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, colorScheme, reducedMotion: "reduce", acceptDownloads: false });
  return { browser, context, attached: true, signedIn: false };
}

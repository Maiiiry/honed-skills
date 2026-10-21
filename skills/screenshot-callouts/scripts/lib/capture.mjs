// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Capture a live page and measure every `selector` target on it, then render. This is the most
// exact route, because the boxes come from the DOM, not from pixels. Each trap below was hit in
// a real capture run before it became a check:
//   - browser zoom other than 100% moves every box by the zoom factor (innerWidth != viewport);
//   - device pixel ratio has to be set at launch; an override on a running page can be ignored;
//   - a selector can match several elements, and .first() silently takes one;
//   - an element can be covered (modal, sticky header, cookie banner) and still have a box;
//   - an element below the fold has a box but is not in a viewport shot;
//   - layout settles late, so boxes are read until two reads agree.
// The written shot is the measured frame itself, with every redaction filled in memory before
// the one write, so the secret pixels never reach a file, and the refs file omits their selectors, so it does not record where the secret sat on the page. The refs
// file records no page text at all: any element's text can hold what a redaction hides.

import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { AnnotateError, missingDep, refused, usage } from "./errors.mjs";
import { assertNotInput, readJsonFile, specOutputPath, writeFresh } from "./files.mjs";
import { decode, encode, fillRect, MAX_INPUT_PIXELS, MAX_SIDE, pixelRect, sha256 } from "./png.mjs";
import { renderSpec } from "./render.mjs";
import { parseSpec } from "./spec.mjs";
import { color, PALETTE } from "./tokens.mjs";

/**
 * Replace every {selector} target with {ref} and collect the selectors to measure. The ref keys
 * are numbered internally (`s1`, `s2`, ...), never built from annotation ids, so an id such as
 * "crop" or "a.from" can never collide with another target's key. `labels` maps each key back to
 * the place in the spec it came from, for error messages.
 */
export function extractSelectors(raw) {
  const selectors = {};
  const labels = {};
  const redactRefs = new Set();
  let n = 0;
  const swap = (t, label, isRedact) => {
    if (!t || typeof t !== "object" || t.selector === undefined) return t;
    if (typeof t.selector !== "string" || !t.selector.trim()) throw usage("TARGET_INVALID", "selector is a non-empty CSS or Playwright selector", { id: label });
    const ref = `s${++n}`;
    selectors[ref] = t.selector;
    labels[ref] = label;
    if (isRedact) redactRefs.add(ref);
    const { selector: _s, ...rest } = t;
    return { ...rest, ref };
  };
  const annotations = (raw.annotations ?? []).map((a, i) => {
    const id = a.id ?? `a${i + 1}`;
    // Only a selector can be masked at capture time. Any other form would leave the secret in
    // the raw capture, which is written to disk and kept, so it is refused before any browser starts.
    if (a.kind === "redact" && a.target?.selector === undefined) {
      throw usage("CAPTURE_REDACT_NEEDS_SELECTOR", `redaction "${id}" in a capture spec must target a selector`, {
        id,
        path: `/annotations/${i}/target`,
        fix: "give the secret's element as a selector, or capture first and redact with render",
      });
    }
    const out = { ...a, id };
    out.target = swap(a.target, id, a.kind === "redact");
    if (a.from) out.from = swap(a.from, `${id}.from`, false);
    if (a.targets) out.targets = a.targets.map((t, j) => swap(t, `${id}.${j + 1}`, false));
    return out;
  });
  const crop = raw.crop && raw.crop !== "auto" ? swap(raw.crop, "/crop", false) : raw.crop;
  return { spec: { ...raw, annotations, crop }, selectors, labels, redactRefs };
}

async function boxesOf(locators) {
  const out = {};
  for (const [ref, loc] of Object.entries(locators)) out[ref] = await loc.boundingBox();
  return out;
}

async function settledBoxes(page, locators) {
  let prev = JSON.stringify(await boxesOf(locators));
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(120);
    const now = JSON.stringify(await boxesOf(locators));
    if (now === prev) return JSON.parse(now);
    prev = now;
  }
  throw refused("LAYOUT_UNSTABLE", "element boxes kept moving for 1.2 s", { fix: "wait for the page with --wait-for SELECTOR or --wait MS, or disable the animation" });
}

export async function captureCommand(opt) {
  // A flag given without its value arrives as `true`; every value flag refuses that here.
  for (const k of ["url", "spec", "out", "dpr", "viewport", "wait", "wait-for", "click", "color-scheme", "channel", "cdp"]) {
    if (opt[k] === true) throw usage("USAGE", `--${k} needs a value`, { path: `--${k}` });
  }
  if (!opt.url || !opt.spec) throw usage("USAGE", "capture needs --url URL --spec SPEC.json");
  if (opt.wait !== undefined && !(Number(opt.wait) >= 0 && Number(opt.wait) <= 60_000)) throw usage("USAGE", "--wait is 0 to 60000 ms", { path: "--wait" });
  if (opt["color-scheme"] !== undefined && !["light", "dark"].includes(opt["color-scheme"])) throw usage("USAGE", "--color-scheme is light or dark", { path: "--color-scheme", candidates: ["light", "dark"] });
  if (opt.channel !== undefined && !["chrome", "msedge"].includes(opt.channel)) throw usage("USAGE", "--channel is chrome or msedge", { path: "--channel", candidates: ["chrome", "msedge"] });
  let u;
  try {
    u = new URL(opt.url);
  } catch {
    throw usage("USAGE", "--url must be absolute", { path: "--url", fix: "use http://localhost:PORT/... or file:///absolute/path.html" });
  }
  if (!["http:", "https:", "file:"].includes(u.protocol)) throw usage("USAGE", "url must be http, https or file");
  const specPath = resolve(opt.spec);
  const raw = readJsonFile(specPath, "--spec");
  const { spec, selectors, labels, redactRefs } = extractSelectors(raw);
  // Validate everything except the image before a browser starts, so a typo costs nothing.
  parseSpec({ ...spec, image: "capture.png" });
  const [vw, vh] = String(opt.viewport ?? "1440x900").split("x").map(Number);
  const dpr = Number(opt.dpr ?? 2);
  if (![vw, vh].every((v) => Number.isInteger(v) && v >= 100 && v <= 8000)) throw usage("USAGE", "--viewport is WIDTHxHEIGHT in CSS px, such as 1440x900", { path: "--viewport" });
  if (!(dpr >= 0.5 && dpr <= 4)) throw usage("USAGE", "--dpr is a number from 0.5 to 4", { path: "--dpr" });
  const who = (ref) => labels[ref] ?? ref;
  const fullPage = Boolean(opt["full-page"]);
  // Output paths are settled before a browser starts: --out, else the spec's own `out` under the
  // folder rule, else beside the spec. The spec's `excalidraw` follows the same rule.
  const out = opt.out
    ? resolve(opt.out)
    : spec.out
      ? specOutputPath(dirname(specPath), spec.out, ".png", "/out")
      : join(dirname(specPath), `${basename(specPath).replace(/\.json$/, "")}.annotated.png`);
  const excalidraw = spec.excalidraw ? specOutputPath(dirname(specPath), spec.excalidraw, ".excalidraw", "/excalidraw") : undefined;
  const stem = out.replace(/\.png$/i, "").replace(/\.annotated$/, "");

  const { attach, launch } = await import("./browser.mjs");
  let browser;
  let page;
  let closeAll;
  const warnings = [];
  let signedIn = false;
  let attached;
  if (opt.cdp) {
    // A fresh context by default: no cookies or storage from the attached browser, so the capture
    // shows what a stranger sees, unless enterprise SSO or a client certificate signs the page in
    // anyway. --signed-in uses the browser's own session, and then everything the account shows
    // (names, mail, balances) lands in the capture.
    let a;
    try {
      a = await attach(opt.cdp, { signedIn: Boolean(opt["signed-in"]), viewport: { width: vw, height: vh }, dpr, colorScheme: opt["color-scheme"] ?? "light" });
    } catch (e) {
      // The origin only: a CDP URL can carry a token in its path or query.
      let where = "the --cdp address";
      try {
        where = new URL(opt.cdp).origin;
      } catch {}
      throw missingDep("CDP_UNREACHABLE", `no browser answers at ${where}`, { fix: "start the browser with --remote-debugging-port, or capture without --cdp" });
    }
    signedIn = a.signedIn;
    attached = a;
    // Close our tab (and our context), then disconnect. On a CDP connection browser.close() only
    // drops the link; the user's own tabs stay open. Without it the process never exits.
    closeAll = async () => {
      await page?.close().catch(() => undefined);
      if (!a.signedIn) await a.context.close().catch(() => undefined);
      await a.browser.close();
    };
    if (opt["signed-in"] && !signedIn) warnings.push("--signed-in: the browser has no session to use, so a fresh context was opened");
  } else {
    browser = await launch({ channel: opt.channel });
    closeAll = () => browser.close();
  }
  // One deadline for the whole capture: page.evaluate takes no timeout, so a page that busy-loops
  // after load would hang the run, and with --cdp spin the user's own browser. Closing the tab
  // ends every pending call.
  let timedOut = false;
  let targets = null; // a browser-level DevTools session that closes the windows this tab opens
  // Set once the page is measured: a check that its document is still the one being measured.
  let sameDocument = async () => true;
  const deadline = setTimeout(() => {
    timedOut = true;
    page?.close().catch(() => undefined);
  }, 120_000 + (Number(opt.wait) || 0));
  try {
    if (attached) {
      page = await attached.context.newPage(); // a NEW tab: never drive one of the user's own tabs
      if (signedIn) {
        await page.setViewportSize({ width: vw, height: vh });
        warnings.push("--signed-in: the capture shows the signed-in account; redact names, addresses and ids before sharing");
      }
    } else {
      const context = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, colorScheme: opt["color-scheme"] ?? "light", reducedMotion: "reduce", acceptDownloads: false });
      page = await context.newPage();
    }
    // Every window this tab opens is closed at once, and so is every window those open: the
    // bundled Chromium runs with popup blocking off, so a page could otherwise open itself in a
    // loop until the machine runs out of memory. Only windows descended from this tab are
    // touched, never the user's own tabs in an attached browser.
    // No window.open in the capture's tab: set before any page script runs, and fixed in place.
    // Headless Chrome blocks no popups (measured: neither its blocker nor a switch stops a
    // timer's window.open), so a page could otherwise open itself in a loop until the machine
    // runs out of memory. The guards below close whatever still opens, a link with a target.
    // The three-argument document.open opens a window too. An accessor whose setter ignores the
    // write: a strict-mode page that wraps window.open must not throw at boot.
    const noPopups = () => {
      const none = () => null;
      Object.defineProperty(window, "open", { get: () => none, set: () => undefined, configurable: false });
      const docOpen = Document.prototype.open;
      Object.defineProperty(Document.prototype, "open", {
        value(...a) {
          return a.length >= 3 ? null : docOpen.apply(this, a);
        },
        writable: false,
        configurable: false,
      });
    };
    // In a context this tool created, every page gets it, popups included; the signed-in
    // context is the user's own, so there only the capture's tab does.
    if (signedIn) await page.addInitScript(noPopups);
    else await page.context().addInitScript(noPopups);
    // Ownership is kept at the browser's target level, by opener id, which a window keeps after
    // its opener has closed: a popup that closes itself first cannot free its own children.
    try {
      const owned = new Set();
      const own = await page.context().newCDPSession(page);
      owned.add((await own.send("Target.getTargetInfo")).targetInfo.targetId);
      await own.detach();
      targets = await page.context().browser().newBrowserCDPSession();
      targets.on("Target.targetCreated", ({ targetInfo: t }) => {
        if (!t.openerId || !owned.has(t.openerId)) return;
        owned.add(t.targetId);
        targets.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
      });
      await targets.send("Target.setDiscoverTargets", { discover: true });
    } catch {
      // A browser without a browser-level session still has the page-level guard below.
    }
    // A context this tool created holds nothing of the user's: every other page in it goes.
    // Only the signed-in context, the user's own, needs the lineage above.
    if (!signedIn) {
      page.context().on("page", (p) => {
        if (p !== page) p.close().catch(() => undefined);
      });
    }
    try {
      await page.goto(opt.url, { waitUntil: "load", timeout: 60_000 });
    } catch (e) {
      // The network error code and the origin only: the URL's path or query can carry an id or a token.
      const code = /net::[A-Z_]+/.exec(String(e?.message))?.[0] ?? (/Timeout/i.test(String(e?.name)) ? "timeout" : "error");
      throw refused("PAGE_LOAD", `the page did not load (${code}) at ${u.protocol === "file:" ? `file:${basename(u.pathname)}` : u.origin}`, { fix: "check the URL and that the server runs" });
    }
    // Where the page landed, not the typed URL: a redirect to https or www is normal. The click
    // check and the refs file both use it.
    const landed = new URL(page.url());
    // An opaque origin (a file: page) serializes as "null", so there the whole URL is compared.
    const site = (href) => {
      const x = new URL(href);
      return x.origin === "null" ? `${x.protocol}${x.pathname}` : x.origin;
    };
    // The page must stay on this site to the end: checked after the click, after the waits and
    // once page scripts are frozen, so a redirect on a timer cannot swap in another site's page.
    const home = site(page.url());
    const stayed = () => {
      const now = new URL(page.url());
      if (site(page.url()) !== home) throw refused("PAGE_LOAD", `the page left its site for ${now.origin === "null" ? now.protocol : now.origin} before it was measured`, { fix: "capture the page it lands on, by its own URL" });
    };
    const where = landed.protocol === "file:" ? `file:${basename(landed.pathname)}` : landed.origin;
    // One click before measuring, for what a fresh visit shows first: a consent banner's accept or
    // close button, or the tab that holds the target.
    // Like a target, it must match exactly one visible element: a page can put a second match first.
    // A popup it opens is closed at once, and a click that leaves the page's origin is refused.
    if (opt.click) {
      if (signedIn) warnings.push("--click: the click lands in your signed-in profile, and a consent choice it makes stays there");
      // Visible matches only, waited for: a consent manager inserts its banner hidden and shows it
      // later. The click goes through the same locator, which Playwright's strict mode refuses to
      // aim at more than one element, so the counted element is the clicked one.
      const shown = page.locator(opt.click).filter({ visible: true });
      try {
        await shown.first().waitFor({ state: "visible", timeout: 10_000 });
      } catch (e) {
        if (/Timeout/i.test(String(e?.name ?? e))) throw refused("TARGET_MISSING", "the --click selector matched nothing visible within 10 s", { path: "--click", fix: "check the selector in the page; a banner inside an iframe cannot be reached" });
        throw usage("TARGET_INVALID", "the --click selector is not valid", { path: "--click" });
      }
      const n = await shown.count();
      if (n !== 1) throw refused("TARGET_AMBIGUOUS", `the --click selector matches ${n} visible elements, not 1`, { path: "--click", fix: "make the selector unique, for example with an id" });
      // The click goes through a handle bound to THIS document, after the site is checked: a
      // redirect during the wait leaves the handle detached, so the click can never land on a
      // control of the site the page went to (in a signed-in profile, an action there).
      stayed();
      const before = home;
      const grab = async () => {
        try {
          return await shown.elementHandle({ timeout: 10_000 });
        } catch (e) {
          stayed();
          if (/strict mode/i.test(String(e?.message))) throw refused("TARGET_AMBIGUOUS", "the --click selector matched a second visible element before the click", { path: "--click", fix: "make the selector unique, for example with an id" });
          throw refused("TARGET_MISSING", "the --click element went away before it was clicked", { path: "--click", fix: "check the selector in the page" });
        }
      };
      // A consent manager often reloads or redirects after Accept: the navigation is awaited, so
      // the check and the measuring see the page it lands on.
      let nav;
      const clickOnce = async () => {
        const target = await grab();
        stayed();
        nav = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 1500 }).catch(() => null);
        await target.click({ timeout: 10_000 });
      };
      try {
        await clickOnce();
      } catch (e) {
        if (e instanceof AnnotateError) throw e;
        stayed();
        // A banner that re-renders swaps its button for an identical node, which detaches the
        // handle before any input is sent: then, and only then, the button is found and clicked
        // once more. Any other failure may come after the click landed, and a second click
        // could submit twice.
        const detached = /not attached|detached/i.test(String(e?.message));
        if (!detached || (await nav)) throw refused("TARGET_COVERED", "the --click element could not be clicked (covered or disabled)", { path: "--click", fix: "check the selector in the page" });
        try {
          await clickOnce();
        } catch (e2) {
          if (e2 instanceof AnnotateError) throw e2;
          stayed();
          throw refused("TARGET_COVERED", "the --click element could not be clicked (covered, disabled or replaced)", { path: "--click", fix: "check the selector in the page" });
        }
      }
      if (await nav) await page.waitForLoadState("load").catch(() => undefined);
      if (site(page.url()) !== before) stayed();
    }
    if (opt["wait-for"]) {
      try {
        await page.waitForSelector(opt["wait-for"], { timeout: 30_000 });
      } catch (e) {
        if (/Timeout/i.test(String(e?.name ?? e))) throw refused("PAGE_LOAD", "the --wait-for selector did not appear within 30 s", { path: "--wait-for", fix: "check the selector in the page, or wait with --wait MS" });
        throw usage("TARGET_INVALID", "the --wait-for selector is not valid", { path: "--wait-for" });
      }
    }
    if (opt.wait) await page.waitForTimeout(Number(opt.wait));
    stayed();

    // From here on the page must stay put: a navigation would measure one document and write
    // another, so it becomes a refusal instead of a raw Playwright error.
    // A private mark on this window: a new document has none. A same-document URL change (a
    // scroll-spy's replaceState, a hash) keeps it, and keeps every measured box valid.
    const DOC = "screenshot-callouts.document";
    await page.evaluate((k) => Object.defineProperty(window, Symbol.for(k), { value: true }), DOC);
    sameDocument = () => page.evaluate((k) => window[Symbol.for(k)] === true, DOC).catch(() => false);
    const probe = await page.evaluate(() => ({ iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio }));
    // The signed-in context keeps the user's own zoom and scale, so only it skips this check.
    if (!signedIn && (probe.iw !== vw || Math.abs(probe.dpr - dpr) > 0.01)) {
      throw refused("ZOOM_MISMATCH", `the page reports ${probe.iw} CSS px at dpr ${probe.dpr}, the capture asked for ${vw} at ${dpr}`, { fix: "reset the browser zoom to 100%; boxes would land off by the zoom factor" });
    }
    const realDpr = probe.dpr;

    const locators = {};
    for (const [ref, sel] of Object.entries(selectors)) {
      const loc = page.locator(sel);
      // A redaction's selector can hold the text it hides, so a refusal does not repeat it.
      const said = redactRefs.has(ref) ? "(the redaction's selector)" : sel;
      let n;
      try {
        n = await loc.count();
      } catch {
        throw usage("TARGET_INVALID", `selector is not valid: ${said}`, { id: who(ref) });
      }
      if (n === 0) throw refused("TARGET_MISSING", `selector matched nothing: ${said}`, { id: who(ref), fix: "check the selector in the page, or wait for it with --wait-for" });
      if (n > 1) throw refused("TARGET_AMBIGUOUS", `selector matched ${n} elements: ${said}`, { id: who(ref), fix: "make it unique (an id, a data-testid, :nth-match(...))" });
      locators[ref] = loc;
    }

    // Finish every running animation first, as the screenshot's `animations: "disabled"` will. A
    // box measured mid-animation is not the box in the shot, and Playwright's scroll waits for an
    // element to stop moving, which an endless spinner or pulse never does. An endless animation
    // cannot finish, so it is cancelled.
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        try {
          a.finish();
        } catch {
          a.cancel();
        }
      }
    });
    const scrollTo = async (ref, loc) => {
      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
      } catch {
        throw refused("LAYOUT_UNSTABLE", `"${who(ref)}" never stopped moving long enough to scroll to`, { id: who(ref), fix: "wait for the page with --wait-for SELECTOR or --wait MS, or target a still ancestor" });
      }
    };

    // A box first: scrolling waits up to 30 s for an element that has none (display:none, a
    // collapsed menu) and then throws, which would read as a crash. Whether the element really
    // SHOWS is decided later, from the pixels of the shot itself.
    for (const [ref, loc] of Object.entries(locators)) {
      const sized = await loc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!sized) throw refused("TARGET_NO_BOX", `"${who(ref)}" has no visible box`, { id: who(ref), fix: "an outline step on it would paint nothing; target a visible ancestor, or open the menu or tab first" });
      await scrollTo(ref, loc);
    }

    if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
    else {
      const first = Object.values(locators)[0];
      await page.evaluate(() => window.scrollTo(0, 0));
      if (first) await scrollTo(Object.keys(locators)[0], first);
    }
    const boxes = await settledBoxes(page, locators);
    const geo = await page.evaluate(() => ({
      sx: window.scrollX,
      sy: window.scrollY,
      w: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      iw: window.innerWidth,
      ih: window.innerHeight,
    }));
    const size = fullPage ? { width: geo.w, height: geo.h } : { width: geo.iw, height: geo.ih };
    // Every shot is decoded in memory, under the same pixel cap as an input: refused here, before
    // any shot, with fixes that work for a capture.
    const shotPx = Math.ceil(size.width * realDpr) * Math.ceil(size.height * realDpr);
    if (shotPx > MAX_INPUT_PIXELS || Math.ceil(size.width * realDpr) > MAX_SIDE || Math.ceil(size.height * realDpr) > MAX_SIDE) {
      throw refused("INPUT_TOO_LARGE", `the shot would be ${Math.ceil(size.width * realDpr)}x${Math.ceil(size.height * realDpr)} px, above ${shotPx > MAX_INPUT_PIXELS ? `${MAX_INPUT_PIXELS} pixels` : `${MAX_SIDE} px on a side`}`, { fix: "use --dpr 1, a narrower --viewport, or targets that fit one viewport without --full-page" });
    }
    const origin = fullPage ? { kind: "fullPage", x: -geo.sx, y: -geo.sy } : { kind: "viewport", x: 0, y: 0 };
    if (!fullPage) {
      for (const [ref, b] of Object.entries(boxes)) {
        if (b.y < 0 || b.x < 0 || b.y + b.height > geo.ih + 1 || b.x + b.width > geo.iw + 1) {
          throw refused("TARGET_OFF_FRAME", `"${who(ref)}" is not inside the viewport together with the other targets`, { id: who(ref), fix: "use --full-page, a taller --viewport, or split the figure" });
        }
      }
    }

    // Every shot is clipped to the size that was checked: a page can grow its layout through CSS
    // when the probe fades a target, and an unclipped full-page shot would follow it.
    const shotOptions = {
      fullPage,
      ...(fullPage ? { clip: { x: 0, y: 0, width: size.width, height: size.height } } : {}),
      scale: "device",
      animations: "disabled",
      caret: "hide",
    };
    // Page scripts are frozen from the reference shot to the last probe, through the DevTools
    // protocol: no observer can undo a probe, no requestAnimationFrame loop or timer can change
    // pixels between two shots. Videos are paused first, since they play without scripts.
    // Playwright's own evaluate keeps working while page scripts are frozen.
    await page.evaluate(() => document.querySelectorAll("video").forEach((v) => v.pause()));
    const cdp = await page.context().newCDPSession(page);
    let img;
    try {
      await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
      stayed();
      // Every element in the top layer (open popovers, modal dialogs), from the browser itself, so
      // one inside a CLOSED shadow root is found too. The top layer ignores its ancestors' opacity,
      // so a redaction's probe also fades each one that lies inside the target: walked up from the
      // top-layer node through parents and shadow hosts (closed ones included) to the marked target.
      await cdp.send("DOM.getDocument", { depth: 0 });
      const topLayer = [];
      // Fails closed: a browser that cannot list its top layer could leave a popover's secret unmeasured.
      let topIds = [];
      try {
        topIds = (await cdp.send("DOM.getTopLayerElements")).nodeIds;
      } catch {
        if (redactRefs.size) throw refused("BROWSER_UNSUPPORTED", "this browser cannot list its top layer, so a redaction cannot be measured", { fix: "use a current Chrome, Edge or Chromium, or redact by box with render" });
      }
      for (const nodeId of topIds) {
        const node = await cdp.send("DOM.resolveNode", { nodeId }).catch(() => null);
        // A ::backdrop is listed too: it paints no text of its own, so it is left alone.
        if (node?.object?.objectId && node.object.subtype === "node") topLayer.push(node.object.objectId);
        else if (node?.object?.className !== "CSSPseudoElement" && redactRefs.size) throw refused("BROWSER_UNSUPPORTED", "a top-layer element could not be resolved, so a redaction cannot be measured", { fix: "redact by box with render" });
      }
      const FADE =
        "function(){ let n=this; while (n && !n[Symbol.for('screenshot-callouts.probe')]) n = n.assignedSlot || n.parentNode || n.host; if (!n) return null; const was=[this.hasAttribute('style'), this.style.cssText]; this.style.setProperty('transition','none','important'); this.style.setProperty('opacity','0','important'); return [was, getComputedStyle(this).opacity === '0']; }";
      const UNFADE = "function(has, css){ this.style.cssText = css; if (!has) this.removeAttribute('style'); }";
      const handles = {};
      for (const [ref, loc] of Object.entries(locators)) handles[ref] = await loc.elementHandle();
      // The DOM boxes as measured, before a redaction's box grows to its ink: they are read again
      // after the last probe, so a late layout shift (a lazy image, a font swap) is caught.
      const measured = JSON.parse(JSON.stringify(boxes));
      // The reference shot is the frame that is measured AND the one that is written, after the
      // redactions are filled in memory: no second shot can differ from it (a GIF frame, a lazy
      // image). A second unchanged shot marks noise (a playing GIF, a native widget): those pixels
      // never count as a target showing.
      const probeOptions = shotOptions;
      const base = decode(await page.screenshot(probeOptions));
      img = base;
      const again = decode(await page.screenshot(probeOptions));
      if (again.width !== img.width || again.height !== img.height) {
        throw refused("LAYOUT_UNSTABLE", "the page changed size between two shots", { fix: "wait for the page with --wait-for SELECTOR or --wait MS" });
      }
      const noise = new Uint8Array(img.width * img.height);
      for (let i = 0; i < noise.length; i++) {
        const k = i * 4;
        if (base.data[k] !== again.data[k] || base.data[k + 1] !== again.data[k + 1] || base.data[k + 2] !== again.data[k + 2]) noise[i] = 1;
      }
      // Every target is measured from PIXELS, not from the DOM: the page is shot again with the
      // target at opacity 0, and every pixel that changes is what it paints. Opacity, not
      // visibility: a descendant can set visibility:visible under a hidden parent, but no descendant
      // can undo its ancestor's opacity. Each DOM version of these checks (overflow, clipping,
      // slots, shadow roots, hit testing, pointer-events) missed one more CSS case per review round.
      //   - A redaction covers everything it paints: the mask covers its own box, and the changed
      //     pixels outside it (overflowing, slotted or shadow text, a pseudo element) are filled too.
      //   - Any other target must show: when no pixel inside its box changes, it is covered,
      //     clipped away, scrolled out of a panel, or transparent, and the figure would mark nothing.
      // Every shot stays in memory; only the filled image below is ever written.
      for (const ref of Object.keys(locators)) {
        // The element and every top-layer element inside it (an open popover or modal dialog):
        // the top layer ignores its ancestors' opacity, so it is faded on its own.
        // The probe's element list lives in a private handle, never in a page global a page
        // could replace. It holds the element and every top-layer element under it, its own
        // shadow root included: the top layer ignores its ancestors' opacity.
        const list = await handles[ref].evaluateHandle((el) => {
          el[Symbol.for("screenshot-callouts.probe")] = true; // removed in the finally below
          return [el];
        });
        const isRedaction = redactRefs.has(ref);
        // Saved and restored through the CSSOM, which a strict Content-Security-Policy allows where
        // it refuses setAttribute("style").
        const saved = await list.evaluate((out) => out.map((n) => [n.hasAttribute("style"), n.style.cssText]));
        let hidden;
        let hidden2;
        const topSaved = [];
        try {
          if (isRedaction) {
            for (const objectId of topLayer) {
              const r = await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: FADE, returnByValue: true }).catch(() => null);
              if (!r || r.exceptionDetails) throw refused("TARGET_INVALID", `a popover or dialog could not be checked while "${who(ref)}" was measured`, { id: who(ref), fix: "close it first, or redact by box with render" });
              const v = r.result?.value;
              if (v) topSaved.push([objectId, v[0]]);
              if (v && !v[1]) throw refused("TARGET_INVALID", `a popover or dialog inside "${who(ref)}" could not be faded for measuring`, { id: who(ref), fix: "close it first, or redact by box with render" });
            }
          }
          const faded = await list.evaluate((out) =>
            out.every((n) => {
              // No transition: one on opacity would report the start value and keep pixels moving.
              n.style.setProperty("transition", "none", "important");
              n.style.setProperty("opacity", "0", "important");
              return getComputedStyle(n).opacity === "0";
            }),
          );
          if (!faded) throw refused("TARGET_INVALID", `"${who(ref)}" could not be faded for measuring`, { id: who(ref), fix: "target a wider ancestor, or redact by box with render" });
          hidden = decode(await page.screenshot(probeOptions));
          // A second faded shot tells the element's own animated content (a GIF inside it) from
          // the page's: a pixel that keeps changing while the element is faded is not its ink.
          if (isRedaction) hidden2 = decode(await page.screenshot(probeOptions));
          if (hidden2 && (hidden2.width !== img.width || hidden2.height !== img.height)) {
            throw refused("LAYOUT_UNSTABLE", `the page changed size while "${who(ref)}" was measured`, { id: who(ref), fix: "wait for the page with --wait-for SELECTOR or --wait MS" });
          }
        } finally {
          for (const [objectId, was] of topSaved) {
            await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: UNFADE, arguments: [{ value: was[0] }, { value: was[1] }] }).catch(() => undefined);
          }
          // The style attribute comes back exactly as it was, absence included.
          await list.evaluate(
            (out, was) =>
              out.forEach((n, i) => {
                n.style.cssText = was[i][1];
                if (!was[i][0]) n.removeAttribute("style");
                delete n[Symbol.for("screenshot-callouts.probe")];
              }),
            saved,
          );
          await list.dispose();
        }
        if (hidden.width !== img.width || hidden.height !== img.height) {
          throw refused("LAYOUT_UNSTABLE", `the page changed size while "${who(ref)}" was measured`, { id: who(ref), fix: "wait for the page with --wait-for SELECTOR or --wait MS" });
        }
        const b = boxes[ref];
        const bx0 = Math.max(0, Math.floor((b.x - origin.x) * realDpr));
        const by0 = Math.max(0, Math.floor((b.y - origin.y) * realDpr));
        const bx1 = Math.min(img.width, Math.ceil((b.x - origin.x + b.width) * realDpr));
        const by1 = Math.min(img.height, Math.ceil((b.y - origin.y + b.height) * realDpr));
        let x0 = bx0;
        let y0 = by0;
        let x1 = bx1;
        let y1 = by1;
        let inside = 0;
        let sx0 = Infinity;
        let sy0 = Infinity;
        let sx1 = -Infinity;
        let sy1 = -Infinity;
        const a = base.data;
        const h = hidden.data;
        const h2 = hidden2?.data;
        // Pixels that change while the element is faded too are AMBIGUOUS: an animation elsewhere,
        // or the element's own translucent ink over an animated background. They are kept when
        // they connect, through changed pixels, to the element's certain ink: a 12 px grid of
        // changed cells is flooded from the box. An animated image far away stays out; overflowing
        // text over an animation stays in. Nothing ambiguous is dropped silently near the element.
        const CELL = 12;
        const cw = Math.ceil(img.width / CELL);
        const ch = Math.ceil(img.height / CELL);
        const changedCell = new Uint8Array(cw * ch);
        const seedCell = new Uint8Array(cw * ch);
        const ambig = new Map(); // cell -> [x0, y0, x1, y1] of its ambiguous pixels
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * 4;
            if (a[i] !== h[i] || a[i + 1] !== h[i + 1] || a[i + 2] !== h[i + 2]) {
              // Showing means a clear change: more than 8 levels, outside the noise.
              const strong = Math.abs(a[i] - h[i]) + Math.abs(a[i + 1] - h[i + 1]) + Math.abs(a[i + 2] - h[i + 2]) > 24;
              const inBox = x >= bx0 && x < bx1 && y >= by0 && y < by1;
              if (strong && !noise[i / 4] && inBox) {
                inside++;
                if (x < sx0) sx0 = x;
                if (x + 1 > sx1) sx1 = x + 1;
                if (y < sy0) sy0 = y;
                if (y + 1 > sy1) sy1 = y + 1;
              }
              const c = Math.floor(y / CELL) * cw + Math.floor(x / CELL);
              changedCell[c] = 1;
              // Either shot pair can catch an animation: one that showed the same frame in both
              // reference shots still changes between the two faded ones.
              if (!inBox && h2 && (h[i] !== h2[i] || h[i + 1] !== h2[i + 1] || h[i + 2] !== h2[i + 2])) {
                const r = ambig.get(c);
                if (r) {
                  if (x < r[0]) r[0] = x;
                  if (y < r[1]) r[1] = y;
                  if (x + 1 > r[2]) r[2] = x + 1;
                  if (y + 1 > r[3]) r[3] = y + 1;
                } else ambig.set(c, [x, y, x + 1, y + 1]);
                continue;
              }
              seedCell[c] = 1;
              if (x < x0) x0 = x;
              if (x + 1 > x1) x1 = x + 1;
              if (y < y0) y0 = y;
              if (y + 1 > y1) y1 = y + 1;
            }
          }
        }
        if (redactRefs.has(ref) && ambig.size) {
          for (let cy = Math.floor(by0 / CELL); cy <= Math.min(ch - 1, Math.floor((by1 - 1) / CELL)); cy++) {
            for (let cx = Math.floor(bx0 / CELL); cx <= Math.min(cw - 1, Math.floor((bx1 - 1) / CELL)); cx++) seedCell[cy * cw + cx] = 1;
          }
          const seen = new Uint8Array(cw * ch);
          const queue = [];
          for (let c = 0; c < seedCell.length; c++) if (seedCell[c]) (seen[c] = 1), queue.push(c);
          while (queue.length) {
            const c = queue.pop();
            const r = ambig.get(c);
            if (r) {
              if (r[0] < x0) x0 = r[0];
              if (r[1] < y0) y0 = r[1];
              if (r[2] > x1) x1 = r[2];
              if (r[3] > y1) y1 = r[3];
            }
            const cx = c % cw;
            const cy = (c - cx) / cw;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
                const n = ny * cw + nx;
                if (!seen[n] && changedCell[n]) (seen[n] = 1), queue.push(n);
              }
            }
          }
          // Changing pixels near the element that do not connect to it are left as they are: say
          // where, so a detached part of the secret over an animation is checked before sharing.
          const near = 200 * realDpr;
          let w0 = Infinity;
          let wy0 = Infinity;
          let w1 = -Infinity;
          let wy1 = -Infinity;
          for (const [c, r] of ambig) {
            if (seen[c] || r[2] < bx0 - near || r[0] > bx1 + near || r[3] < by0 - near || r[1] > by1 + near) continue;
            w0 = Math.min(w0, r[0]);
            wy0 = Math.min(wy0, r[1]);
            w1 = Math.max(w1, r[2]);
            wy1 = Math.max(wy1, r[3]);
          }
          if (w1 > w0) {
            const css = (v) => Math.round(v / realDpr);
            warnings.push(`redaction "${who(ref)}": pixels that keep changing near it were not counted as its ink, at ${css(w0)},${css(wy0)} to ${css(w1)},${css(wy1)} CSS px in the shot; check that area before sharing`);
          }
        }
        if (!redactRefs.has(ref)) {
          // The crop only frames the figure, so it is exempt.
          // Shown means: at least 5 clear CSS px squared, and either 2% of the box or a spread that
          // spans a quarter of the box. A sparse panel spreads its few pixels wide and passes. A
          // dense patch (a card's own background) that fills less than 60% of the box, with another
          // element on top of the rest, is a strip left by a banner or a panel edge, and fails.
          const area = (bx1 - bx0) * (by1 - by0);
          const patch = inside ? (sx1 - sx0) * (sy1 - sy0) : 0;
          const spread = patch / area;
          // Pixels alone cannot tell a strip from content smaller than its box (an image in a wide
          // wrapper), so a strip counts only when another element is on top where the box is
          // blank: a hit test at a grid of points outside the patch, in viewport CSS px.
          let strip = false;
          if (labels[ref] !== "/crop" && inside >= 0.85 * patch && spread < 0.6) {
            const pts = [];
            for (let gy = 1; gy < 6; gy++) {
              for (let gx = 1; gx < 6; gx++) {
                const px = bx0 + ((bx1 - bx0) * gx) / 6;
                const py = by0 + ((by1 - by0) * gy) / 6;
                if (px >= sx0 && px < sx1 && py >= sy0 && py < sy1) continue;
                pts.push([px / realDpr + origin.x, py / realDpr + origin.y]);
              }
            }
            strip = await handles[ref].evaluate((el, points) => {
              const related = (a, b) => {
                for (let n = a; n; n = n.assignedSlot || n.parentNode || n.host) if (n === b) return true;
                return false;
              };
              return points.some(([x, y]) => {
                const hit = document.elementFromPoint(x, y);
                return hit && !related(hit, el) && !related(el, hit);
              });
            }, pts);
          }
          if (labels[ref] !== "/crop" && (inside < Math.max(4, 5 * realDpr * realDpr) || (inside < 0.02 * area && spread < 0.25) || strip)) {
            throw refused("TARGET_COVERED", `"${who(ref)}" does not show in the shot, or barely`, { id: who(ref), fix: "it is covered, clipped away, scrolled out of a panel or transparent: close the overlay, open the menu, use --full-page, or split the figure" });
          }
          continue;
        }
        // A redaction's ink, back in CSS px in the refs file's frame, so render redacts the same area.
        boxes[ref] = { x: x0 / realDpr + origin.x, y: y0 / realDpr + origin.y, width: (x1 - x0) / realDpr, height: (y1 - y0) / realDpr };
      }
      for (const [ref, h] of Object.entries(handles)) {
        const now = await h.boundingBox();
        const was = measured[ref];
        if (!now || Math.abs(now.x - was.x) > 2 || Math.abs(now.y - was.y) > 2 || Math.abs(now.width - was.width) > 2 || Math.abs(now.height - was.height) > 2) {
          throw refused("LAYOUT_UNSTABLE", `"${who(ref)}" moved while the shot was measured`, { id: who(ref), fix: "wait for the page with --wait-for SELECTOR or --wait MS (a late image or font moved it)" });
        }
      }
      // Still frozen, and still under the deadline: no page script can stall this read.
      if (!(await sameDocument())) throw refused("PAGE_LOAD", "the page loaded another document while it was measured", { fix: "wait for it with --wait-for SELECTOR or --wait MS" });
    } finally {
      await cdp.send("Emulation.setScriptExecutionDisabled", { value: false }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
    // The page is done with: what follows is this tool's own work, which no page can stall, so
    // the deadline no longer runs and a slow full-page job is never blamed on the page.
    if (timedOut) throw refused("PAGE_HUNG", "the page did not answer within the capture deadline", { fix: "the page keeps its main thread busy; capture it at a calmer moment, or screenshot it yourself and use render" });
    clearTimeout(deadline);
    // Nothing reads the page after this, the catch below included: it would run unguarded.
    sameDocument = async () => true;
    const padOf = {};
    for (const a of spec.annotations) {
      if (a.target?.ref && redactRefs.has(a.target.ref)) padOf[a.target.ref] = (a.target.pad ?? 0) + (a.pad ?? 0);
    }
    for (const ref of redactRefs) {
      const b = boxes[ref];
      const g = ((padOf[ref] ?? 0) + 2) * realDpr;
      const r = pixelRect(img, { x: (b.x - origin.x) * realDpr - g, y: (b.y - origin.y) * realDpr - g, w: b.width * realDpr + 2 * g, h: b.height * realDpr + 2 * g });
      fillRect(img, r, color(PALETTE.redact));
    }
    const capture = `${stem}.capture.png`;
    const refsPath = `${stem}.capture.refs.json`;
    const resolvedPath = `${stem}.capture.spec.json`;
    const inputs = [specPath];
    const written = [capture, refsPath, resolvedPath, out];
    for (const p of written) assertNotInput(p, inputs, "--out");
    if (new Set(written).size !== written.length) throw refused("OUTPUT_COLLISION", "two capture outputs would share one file name", { path: "--out" });
    const buf = encode(img);
    writeFresh(capture, buf, inputs, "--out");
    // A mark on a redacted field would record where the secret sat through its selector, and a
    // selector can hold page text: one whose box overlaps a redaction keeps its box only.
    // Measured against the filled area: the ink grown by the same (pad + 2) CSS px, plus 1 px of
    // rounding.
    const redactBoxes = [...redactRefs].map((r) => [boxes[r], (padOf[r] ?? 0) + 3]);
    const onRedaction = (b) => redactBoxes.some(([r, g]) => b.x < r.x + r.width + g && b.x + b.width > r.x - g && b.y < r.y + r.height + g && b.y + b.height > r.y - g);
    const refs = {
      version: 1,
      image_sha256: sha256(buf),
      dpr: realDpr,
      units: "css",
      origin,
      size,
      viewport: { width: geo.iw, height: geo.ih },
      // The origin only: a path can carry an account or tenant id, and a file: URL names folders.
      url: where,
      refs: Object.fromEntries(
        Object.entries(boxes).map(([ref, b]) => [
          ref,
          redactRefs.has(ref) || onRedaction(b) ? { box: b, matches: 1 } : { selector: selectors[ref], box: b, matches: 1 },
        ]),
      ),
    };
    writeFresh(refsPath, `${JSON.stringify(refs, null, 2)}\n`, inputs, "--out");
    // Paths relative to the resolved spec, which shares their folder; the spec's own out and
    // excalidraw are dropped, because they were relative to a folder this file may not be in.
    const { out: _o, excalidraw: _e, ...rest } = spec;
    const resolvedSpec = { ...rest, image: basename(capture), refs: basename(refsPath), dpr: realDpr };
    // The export the spec asked for, resolved against the spec's own folder under the spec rule.
    writeFresh(resolvedPath, `${JSON.stringify(resolvedSpec, null, 2)}\n`, inputs, "--out");
    const render = await renderSpec(resolvedSpec, { out, excalidraw, specDir: dirname(resolvedPath), specPath: resolvedPath, inputs: [specPath, capture, refsPath] });
    return { ok: true, capture, refs: refsPath, spec: resolvedPath, render, warnings: [...warnings, ...render.warnings] };
  } catch (e) {
    // A new document mid-measure surfaces first as whatever broke (a missing target, a raw
    // Playwright error): name the cause instead. The read runs under the deadline, and a page
    // the deadline closed is reported as hung, not as navigated.
    const same = e instanceof AnnotateError && e.code === "PAGE_LOAD" ? true : await sameDocument();
    if (timedOut) throw refused("PAGE_HUNG", "the page did not answer within the capture deadline", { fix: "the page keeps its main thread busy; capture it at a calmer moment, or screenshot it yourself and use render" });
    if (page?.isClosed() || /has been closed|Target closed|Browser closed/i.test(String(e?.message))) throw refused("PAGE_HUNG", "the browser or the tab closed during the capture", { fix: "keep the browser open for the run, or capture a lighter page" });
    if (!same) throw refused("PAGE_LOAD", "the page loaded another document while it was measured", { fix: "wait for it with --wait-for SELECTOR or --wait MS" });
    if (e instanceof AnnotateError) throw e;
    // A file system error (a read-only or full --out folder) is this machine's, not the page's.
    if (typeof e?.code === "string" && /^E[A-Z0-9]+$/.test(e.code)) throw e;
    // A raw browser error can quote the page: a strict-mode error previews every element it
    // matched, a redacted one included. Only the call's name before the first colon and the
    // stack frames are kept.
    const raw = String(e?.message);
    if (/strict mode violation/i.test(raw)) throw refused("TARGET_AMBIGUOUS", "a target matched a second element while the page was measured", { fix: "make the selector unique, or wait for the page with --wait-for" });
    // Playwright's fixed phrases carry no page text, and they name ordinary causes, not a bug.
    if (/Execution context was destroyed|most likely because of a navigation/i.test(raw)) throw refused("PAGE_LOAD", "the page loaded another document while it was measured", { fix: "wait for it with --wait-for SELECTOR or --wait MS" });
    if (/has been closed|Target closed|Browser closed/i.test(raw)) throw refused("PAGE_HUNG", "the browser or the tab closed during the capture", { fix: "keep the browser open for the run, or capture a lighter page" });
    const clean = new Error(`a browser call failed in ${String(e?.message ?? "").split(":")[0].slice(0, 60)} (${e?.name ?? "Error"})`);
    clean.stack = [clean.message, ...String(e?.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l))].join("\n");
    throw clean;
  } finally {
    clearTimeout(deadline);
    await targets?.detach().catch(() => undefined);
    await closeAll();
  }
}

// Phase 0 of `npm run once`: log into Instahyre and click apply/confirm on every matching opportunity; never throws out of the run.
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { sleep } from "../util/sleep.js";
import { awaitNetwork } from "../util/connectivity.js";
import { JsonValueSchema } from "../util/json.js";
import { INSTAHYRE_URL, SELECTORS } from "./constants.js";

export interface InstahyreResult {
  applied: number;
  confirmed: number;
  skippedReason: string | null;
  error: string | null;
  durationMs: number;
}

/** Reads INSTAHYRE_EMAIL_<PROFILE>/INSTAHYRE_PASSWORD_<PROFILE> (uppercased); null if either is missing/empty. */
export function instahyreCredsForProfile(
  profileId: string,
  env: NodeJS.ProcessEnv,
): { email: string; password: string } | null {
  const upper = profileId.toUpperCase();
  const email = env[`INSTAHYRE_EMAIL_${upper}`];
  const password = env[`INSTAHYRE_PASSWORD_${upper}`];
  if (!email || !password) return null;
  return { email, password };
}

function statePathFor(profileId: string): string {
  return `data/instahyre-state-${profileId}.json`;
}

function debugScreenshotPathFor(profileId: string): string {
  return `data/instahyre-debug-${profileId}.png`;
}

async function skip(
  result: InstahyreResult,
  reason: string,
  profileId: string,
  start: number,
  page: Page | null,
): Promise<InstahyreResult> {
  logger.info({ profileId, screenshot: page ? debugScreenshotPathFor(profileId) : undefined }, `instahyre: ${reason}, skipping`);
  if (page && !page.isClosed()) {
    try {
      await page.screenshot({ path: debugScreenshotPathFor(profileId), fullPage: true, timeout: 10_000 });
    } catch (err) {
      logger.warn({ profileId, err: String(err) }, "instahyre: debug screenshot failed");
    }
  }
  result.skippedReason = reason;
  result.durationMs = Date.now() - start;
  return result;
}

// Atomic fill so Angular hydration can't swallow leading keystrokes (pressSequentially right after #email appeared dropped the first chars); verifies and falls back to slow typing once.
async function fillVerified(page: Page, selector: string, value: string): Promise<boolean> {
  const loc = page.locator(selector);
  await loc.click();
  await loc.fill(value);
  if ((await loc.inputValue()) === value) return true;
  await loc.fill("");
  await loc.pressSequentially(value, { delay: 50 });
  return (await loc.inputValue()) === value;
}

export async function runInstahyreAutoApply(profileId: string): Promise<InstahyreResult> {
  const start = Date.now();
  const result: InstahyreResult = { applied: 0, confirmed: 0, skippedReason: null, error: null, durationMs: 0 };

  const creds = instahyreCredsForProfile(profileId, process.env);
  if (!creds) {
    return skip(result, "no credentials for profile", profileId, start, null);
  }

  await awaitNetwork();

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
    });
    const statePath = statePathFor(profileId);
    const context = await browser.newContext({
      viewport: null,
      ...(existsSync(statePath) ? { storageState: statePath } : {}),
    });
    const page = await context.newPage();
    // networkidle (not domcontentloaded): the AngularJS app pre-renders per-job apply modals only once the feed XHRs settle; interacting before that leaves the apply modal absent.
    await page.goto(INSTAHYRE_URL, { waitUntil: "networkidle", timeout: config.instahyre.navTimeoutMs });

    let loggedIn: boolean;
    try {
      await page.waitForSelector(`${SELECTORS.email}, ${SELECTORS.interestedBtn}`, {
        timeout: config.instahyre.feedTimeoutMs,
      });
    } catch {
      // Union wait itself timed out and the login form never appeared: an exhausted feed never renders #interested-btn.
      return await skip(result, "feed did not render (no #email or #interested-btn)", profileId, start, page);
    }

    const loginVisible = await page.locator(SELECTORS.email).isVisible();
    if (loginVisible) {
      const emailOk = await fillVerified(page, SELECTORS.email, creds.email);
      const passwordOk = await fillVerified(page, SELECTORS.password, creds.password);
      if (!emailOk || !passwordOk) {
        result.error = "login form rejected typed credentials (field value mismatch)";
        logger.error({ profileId }, "instahyre: could not type credentials into login form");
        result.durationMs = Date.now() - start;
        return result;
      }
      await page.click(SELECTORS.loginSubmit);
      try {
        await page.waitForSelector(SELECTORS.interestedBtn, { timeout: config.instahyre.feedTimeoutMs });
        loggedIn = true;
      } catch {
        const stillLoginForm = await page.locator(SELECTORS.email).isVisible();
        if (stillLoginForm) {
          result.error = "login failed (still on login form)";
          logger.error({ profileId, screenshot: debugScreenshotPathFor(profileId) }, "instahyre: login failed");
          try {
            await page.screenshot({ path: debugScreenshotPathFor(profileId) });
          } catch {
            // best-effort debugging aid only
          }
          result.durationMs = Date.now() - start;
          return result;
        }
        loggedIn = false;
      }
    } else {
      loggedIn = true; // #interested-btn matched directly: session restored
    }

    if (!loggedIn) {
      return await skip(result, "feed empty after login (no #interested-btn)", profileId, start, page);
    }

    // Persist only a confirmed-good session (#interested-btn present); saving a failed login poisons the next run.
    await context.storageState({ path: statePath });

    // Passed as a string (not a typed function): this repo's tsconfig has no "DOM" lib.
    const clickInterestedScript = `(() => {
      const buttons = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.interestedBtn)}));
      const visibleBtn = buttons.find((btn) => {
        const style = window.getComputedStyle(btn);
        return style.display !== "none" && style.visibility !== "hidden" && btn.offsetParent !== null;
      });
      if (visibleBtn) {
        visibleBtn.click();
        return true;
      }
      return false;
    })()`;
    const clickedInterested = JsonValueSchema.parse(await page.evaluate(clickInterestedScript));
    if (clickedInterested !== true) {
      return await skip(result, "no visible interested button to click", profileId, start, page);
    }
    await sleep(1000);

    try {
      await page.waitForSelector(SELECTORS.applyButton, { timeout: config.instahyre.feedTimeoutMs });
    } catch {
      return await skip(result, "apply UI did not appear after opening first job", profileId, start, page);
    }

    const deadline = start + config.instahyre.stepBudgetMs;
    const applyClickScript = `(() => {
      function isUsable(el) {
        if (!el) return false;
        if (el.disabled) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || el.offsetParent === null) return false;
        return true;
      }
      const overlayBtn = document.querySelector(${JSON.stringify(SELECTORS.overlayConfirmButton)});
      if (isUsable(overlayBtn)) {
        overlayBtn.click();
        return "overlay";
      }
      const applyBtn = document.querySelector(${JSON.stringify(SELECTORS.applyButton)});
      if (isUsable(applyBtn)) {
        applyBtn.click();
        return "apply";
      }
      return null;
    })()`;
    for (;;) {
      if (result.applied + result.confirmed >= config.instahyre.maxApplications) {
        logger.info({ profileId, applied: result.applied, confirmed: result.confirmed }, "instahyre: application cap hit");
        break;
      }
      if (Date.now() > deadline) {
        logger.info({ profileId, applied: result.applied, confirmed: result.confirmed }, "instahyre: step budget exhausted");
        break;
      }
      const raw = JsonValueSchema.parse(await page.evaluate(applyClickScript));
      if (raw === null) break;
      if (raw === "overlay") result.confirmed++;
      else if (raw === "apply") result.applied++;
      logger.debug({ profileId, clicked: raw }, "instahyre: click");
      await sleep(config.instahyre.clickIntervalMs);
    }

    logger.info({ profileId, applied: result.applied, confirmed: result.confirmed }, "instahyre auto-apply complete");
  } catch (err) {
    result.error = String(err);
    logger.error({ profileId, err: result.error }, "instahyre auto-apply threw");
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // already closed
      }
    }
  }
  result.durationMs = Date.now() - start;
  return result;
}

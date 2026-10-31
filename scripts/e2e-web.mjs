// The demo in a real browser, end to end: node scripts/e2e-web.mjs [web-url]
// Needs the Worker (wrangler dev --env local) and the web app (vite) running. A virtual platform authenticator
// stands in for Face ID, so the passkey ceremony is the real WebAuthn one.
import { chromium } from "playwright";

const WEB = process.argv[2] ?? "http://localhost:5173";
let failed = false;
const check = (cond, what) => {
  console.log(`${cond ? "✓" : "✗"} ${what}`);
  if (!cond) failed = true;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

/** Sends a chat message once the assistant has finished its last reply (the composer ignores Enter while busy). */
async function say(text) {
  await page.waitForSelector('button[aria-label="Send"]', { timeout: 30000 });
  await page.fill("textarea", text);
  await page.keyboard.press("Enter");
}

/** The latest card's swipe track, once it has risen and the chat has finished scrolling to it. */
async function latestTrack(name) {
  const track = page.getByRole("button", { name }).last();
  await track.waitFor({ timeout: 20000 });
  await track.scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  return track;
}

/** Drags across a track's box: from its start to its end, or back. */
async function drag(box, rightward) {
  const y = box.y + box.height / 2;
  const [from, to] = rightward ? [box.x + 26, box.x + box.width - 6] : [box.x + box.width - 26, box.x + 4];
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move(to, y, { steps: 18 });
  await page.mouse.up();
}

/**
 * One hold: press a pill, wait for its chips, rest on one, slide up into the track by the knob, and swipe. The
 * track's box is taken first, as its name changes to what it says during the hold.
 */
async function holdAndSwipe(pillName, chip, track, rightward) {
  const box = await track.boundingBox();
  const pill = await page.getByRole("button", { name: pillName, exact: true }).last().boundingBox();
  await page.mouse.move(pill.x + pill.width / 2, pill.y + pill.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  const c = await page.locator(`[data-chip="${chip}"]`).boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 6 });
  await page.waitForTimeout(350);
  const y = box.y + box.height / 2;
  const [into, to] = rightward ? [box.x + 30, box.x + box.width - 6] : [box.x + box.width - 30, box.x + 4];
  await page.mouse.move(into, y, { steps: 6 });
  await page.mouse.move(to, y, { steps: 16 });
  await page.mouse.up();
}

try {
  await page.goto(WEB);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click("text=Start the demo");
  await page.waitForSelector("text=What should we do?", { timeout: 15000 });
  check(true, "a new account opens on the chat");

  await page.click("text=Merge PR #182 in okayed");
  await page.waitForSelector("text=/^Merged PR #182 into adrianmross\\/okayed/", { timeout: 20000 });
  check(await page.isVisible("text=by your rules"), "a checked merge is allowed by the default rules: one line, and a one-line reply");

  await say("Deploy openmeadow to production");
  const allow = await latestTrack("Allow once");
  check(await page.isVisible("text=High risk") && await page.isVisible("text=/Allow Assistant to deploy/"), "a production deploy asks, with a high-risk approval card in plain words");
  await drag(await allow.boundingBox(), true);
  await page.waitForSelector("text=Deployed openmeadow.org to production.", { timeout: 30000 });
  check(await page.isVisible("text=with Face ID"), "swiping allows it with Face ID (a passkey bound to the request), and the assistant carries on");

  await say("Buy openmeadow.dev for $12");
  await latestTrack("Pay $12.00");
  await page.getByRole("button", { name: "Not now" }).last().click();
  await page.waitForTimeout(300);
  await drag(await page.getByRole("button", { name: "Swipe for not now" }).last().boundingBox(), false);
  await page.waitForSelector("text=/Okay, I won't/", { timeout: 20000 });
  check(true, "a purchase asks with a money card; Not now, then a swipe left, stops it, and the assistant says so");

  await say("Deploy openmeadow to production");
  await holdAndSwipe("Always", "forever", await latestTrack("Allow once"), true);
  await page.waitForSelector("text=Rule added: allowed from now on.", { timeout: 10000 });
  await page.waitForFunction(() => document.body.innerText.split("Deployed openmeadow.org to production.").length > 2, null, { timeout: 30000 });
  check(true, "holding Always, resting on ∞ and swiping makes a rule and allows this one with one Face ID");

  await say("Deploy buzz.dev to production");
  await holdAndSwipe("Deny", "day", await latestTrack("Allow once"), false);
  await page.waitForSelector("text=Rule added: blocked from now on.", { timeout: 10000 });
  await page.waitForFunction(() => document.body.innerText.split("Okay, I won't").length > 2, null, { timeout: 20000 });
  check(true, "holding Deny, resting on 1d and swiping left blocks requests like it for a day, and refuses this one");

  await page.click('button:has-text("Transcript")');
  check(await page.isVisible("text=/\"assurance\": \"webauthn\"/"), "the transcript records the grant's Face ID assurance");

  await page.goto(`${WEB}/#activity`);
  await page.click('button[role="tab"]:has-text("History")');
  await page.waitForSelector("text=/^[0-9a-f]{8}…[0-9a-f]{4}$/", { timeout: 10000 });
  const receipts = await page.locator("text=/^[0-9a-f]{8}…[0-9a-f]{4}$/").count();
  check(receipts >= 3, `History keeps a signed receipt for each permission (${receipts})`);

  await page.goto(`${WEB}/#rules`);
  check(await page.isVisible("text=Deploy to production"), "the new rule is in Rules");
  check(await page.locator("button", { hasText: "Deploy" }).filter({ hasText: "Blocked" }).count() >= 1, "so is the block, as a Blocked tile");
  await page.click("text=Merge PRs");
  await page.click('button[aria-pressed="false"]:has-text("Ask me")');
  await page.click('button:has-text("Save")');
  await page.waitForSelector("text=Rule saved.", { timeout: 10000 });
  check(true, "a rule can be changed in the Shortcuts-style editor");
} catch (e) {
  check(false, `the flow ran to the end (${e.message.split("\n")[0]})`);
  if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT, fullPage: true });
}
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
process.exit(failed ? 1 : 0);

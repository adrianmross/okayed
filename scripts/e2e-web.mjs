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

try {
  await page.goto(WEB);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click("text=Start the demo");
  await page.waitForSelector("text=What should we do?", { timeout: 15000 });
  check(true, "a new account opens on the chat");

  // Decide by hold and slide on this device. Allow once and Don't allow stay taps; a quick tap on Always allow…
  // still opens the editor.
  await page.goto(`${WEB}/#settings`);
  await page.getByRole("radio", { name: "Hold and slide" }).click();
  await page.goto(`${WEB}/#chat`);
  await page.waitForSelector("text=What should we do?", { timeout: 15000 });

  await page.click("text=Merge PR #182 in okayed");
  await page.waitForSelector("text=/allowed by your rules/", { timeout: 20000 });
  check(await page.isVisible("text=by your rules"), "a checked merge is allowed by the default rules, with a receipt");

  await say("Deploy openmeadow to production");
  const faceId = page.getByRole("button", { name: /^(Allow once|Set up Face ID and allow)$/ }).first();
  await faceId.waitFor({ timeout: 20000 });
  check(await page.isVisible("text=High risk"), "a production deploy asks, with a high-risk approval card");
  await faceId.click();
  await page.waitForSelector("text=/Deployed openmeadow.org to production/", { timeout: 30000 });
  check(await page.isVisible("text=with Face ID"), "Face ID (a passkey bound to the request) allows it, and the assistant carries on");

  await say("Buy openmeadow.dev for $12");
  await page.locator("text=Don't allow").first().waitFor({ timeout: 20000 });
  await page.locator("text=Don't allow").first().click();
  await page.waitForSelector("text=/Okay, I won't/", { timeout: 20000 });
  check(true, "saying no stops the purchase, and the assistant says so");

  await say("Deploy openmeadow to production");
  await page.getByRole("button", { name: "Always allow…" }).last().click();
  await page.getByRole("button", { name: "Add rule and allow" }).click();
  await page.waitForSelector("text=Rule added.", { timeout: 10000 });
  // Each deploy leaves a receipt and a reply that name it: four mentions once both have run.
  await page.waitForFunction(() => document.body.innerText.split("Deployed openmeadow.org to production").length > 4, null, { timeout: 30000 });
  check(true, "“Always allow…” turns the request into a rule and allows it with one Face ID");

  // Hold and slide: Block… held, slid up one rung (1 day) and across, blocks this purchase and ones like it.
  await say("Buy openmeadow.dev for $12");
  const blockBtn = page.getByRole("button", { name: "Block…" }).last();
  await blockBtn.waitFor({ timeout: 20000 });
  // Let the card finish rising and the chat finish scrolling, so the press lands where the button is.
  await blockBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const box = await blockBtn.boundingBox();
  const [bx, by] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(bx, by);
  await page.mouse.down();
  await page.mouse.move(bx, by - 10, { steps: 3 });
  await page.mouse.move(bx, by - 40, { steps: 6 });
  await page.mouse.move(bx + 700, by - 40, { steps: 20 });
  await page.mouse.up();
  await page.waitForSelector("text=Rule added: blocked from now on.", { timeout: 10000 });
  await page.waitForFunction(() => document.body.innerText.split("Okay, I won't").length > 2, null, { timeout: 20000 });
  check(true, "hold and slide on Block… adds a one-day block rule and refuses the purchase");

  await page.click('button:has-text("Transcript")');
  check(await page.isVisible("text=/\"assurance\": \"webauthn\"/"), "the transcript records the grant's Face ID assurance");

  await page.goto(`${WEB}/#activity`);
  await page.click('button[role="tab"]:has-text("History")');
  await page.waitForSelector("text=/^[0-9a-f]{10}$/", { timeout: 10000 });
  const receipts = await page.locator("text=/^[0-9a-f]{10}$/").count();
  check(receipts >= 3, `History keeps a signed receipt for each permission (${receipts})`);

  await page.goto(`${WEB}/#rules`);
  check(await page.isVisible("text=Deploy to production"), "the new rule is in Rules");
  check(await page.locator("button", { hasText: "Spend money" }).filter({ hasText: "Blocked" }).count() >= 1, "so is the block, as a Blocked tile");
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

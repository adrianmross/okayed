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

try {
  await page.goto(WEB);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click("text=Start the demo");
  await page.waitForSelector("text=What should Assistant do?", { timeout: 15000 });
  check(true, "a new account opens on the chat");

  await page.click("text=Merge PR #182 in okayed");
  await page.waitForSelector("text=/approved by your policy/", { timeout: 20000 });
  check(await page.isVisible("text=by your policy"), "a checked merge goes ahead under the default posture, with a receipt");

  await page.fill("textarea", "Deploy openmeadow to production");
  await page.keyboard.press("Enter");
  const faceId = page.locator('button:has-text("Face ID")').first();
  await faceId.waitFor({ timeout: 20000 });
  check(await page.isVisible("text=High risk"), "a production deploy asks, with a high-risk approval card");
  await faceId.click();
  await page.waitForSelector("text=/Deployed openmeadow.org to production/", { timeout: 30000 });
  check(await page.isVisible("text=with Face ID"), "Face ID (a passkey bound to the request) approves it, and Assistant carries on");

  await page.fill("textarea", "Buy openmeadow.dev for $12");
  await page.keyboard.press("Enter");
  await page.locator("text=Don't allow").first().waitFor({ timeout: 20000 });
  await page.locator("text=Don't allow").first().click();
  await page.waitForSelector("text=/Okay, I won't/", { timeout: 20000 });
  check(true, "saying no stops the purchase, and Assistant says so");

  await page.click('button:has-text("Transcript")');
  check(await page.isVisible("text=/\"assurance\": \"webauthn\"/"), "the transcript records the grant's Face ID assurance");

  await page.goto(`${WEB}/#activity`);
  await page.click('button[role="tab"]:has-text("Receipts")');
  await page.waitForSelector("text=/^grant [0-9a-f]{10}$/", { timeout: 10000 });
  check((await page.locator("text=/^grant [0-9a-f]{10}$/").count()) >= 2, "Activity lists a receipt for each grant");

  await page.goto(`${WEB}/#policies`);
  await page.click("text=Merge PRs");
  await page.click('button[aria-pressed="false"]:has-text("Ask me")');
  await page.click('button:has-text("Save")');
  await page.waitForSelector("text=Policy saved.", { timeout: 10000 });
  check(true, "a policy can be changed in the Shortcuts-style editor");
} catch (e) {
  check(false, `the flow ran to the end (${e.message.split("\n")[0]})`);
}
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
process.exit(failed ? 1 : 0);

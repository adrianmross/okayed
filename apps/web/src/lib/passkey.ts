import { WebAuthnAbortService, browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ApiError, call, type Session } from "./session";

/**
 * Some browsers have WebAuthn but never show its prompt (embedded browsers, some in-app webviews): the call neither
 * resolves nor fails. After one goes unanswered, this tab approves without Face ID instead of waiting forever.
 */
let silent = false;
export const passkeysSupported = () => !silent && browserSupportsWebAuthn();

export class PasskeyNoResponse extends Error {}

/** A passkey prompt, given up on when nothing answers in time. */
async function ceremony<T>(run: () => Promise<T>, ms = 45_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      silent = true;
      WebAuthnAbortService.cancelCeremony();
      reject(new PasskeyNoResponse("Face ID didn't respond in this browser, so it's off here. Swipe again to allow without it."));
    }, ms);
  });
  try {
    return await Promise.race([run(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Creates a passkey (Face ID, Touch ID, Windows Hello) for approving on this device. */
export async function setUpPasskey(s: Session): Promise<void> {
  const origin = location.origin;
  const optionsJSON = await call<Parameters<typeof startRegistration>[0]["optionsJSON"]>(s, "POST", "/passkeys/options", { origin });
  const response = await ceremony(() => startRegistration({ optionsJSON }));
  await call(s, "POST", "/passkeys", { origin, response, name: guessName() });
}

/**
 * Approves one card with a passkey. The server's challenge is a hash of exactly what is being approved, so the
 * signature that comes back can only okay this draft. Sets up a passkey first if there isn't one yet.
 */
export async function approveWithPasskey(s: Session, cardId: string): Promise<void> {
  const origin = location.origin;
  let optionsJSON: Parameters<typeof startAuthentication>[0]["optionsJSON"];
  try {
    optionsJSON = await call(s, "POST", `/cards/${cardId}/challenge`, { origin });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 412) throw e;
    await setUpPasskey(s);
    optionsJSON = await call(s, "POST", `/cards/${cardId}/challenge`, { origin });
  }
  const assertion = await ceremony(() => startAuthentication({ optionsJSON }));
  await call(s, "POST", `/cards/${cardId}/confirm`, { origin, assertion });
}

function guessName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "Face ID";
  if (/Mac/.test(ua)) return "Touch ID";
  if (/Windows/.test(ua)) return "Windows Hello";
  if (/Android/.test(ua)) return "Fingerprint";
  return "Passkey";
}

/** What to call the passkey in buttons: "Face ID" on Apple phones, the platform's name elsewhere. */
export const passkeyName = (): string => guessName();

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ApiError, call, type Session } from "./session";

export const passkeysSupported = () => browserSupportsWebAuthn();

/** Creates a passkey (Face ID, Touch ID, Windows Hello) for approving on this device. */
export async function setUpPasskey(s: Session): Promise<void> {
  const origin = location.origin;
  const optionsJSON = await call<Parameters<typeof startRegistration>[0]["optionsJSON"]>(s, "POST", "/passkeys/options", { origin });
  const response = await startRegistration({ optionsJSON });
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
  const assertion = await startAuthentication({ optionsJSON });
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

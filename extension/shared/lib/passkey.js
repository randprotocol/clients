// `platform.passkey` for the Chrome extension: a platform passkey (Touch ID on a Mac, Windows Hello,
// a phone's screen lock) with the WebAuthn PRF extension, which the shared engine uses to seal the
// wallet's password (ui/engine/backend-shared.js `wallet.passkey`, ui/engine/crypto.js).
//
//   available()                 → boolean
//   label()                     → "Touch ID" | "Windows Hello" | "your device's screen lock"
//   register()                  → {credentialId, salt, prf?}
//   prf({credentialId, salt})   → the 32-byte PRF output, after the user's fingerprint
//
// The relying party is the extension itself: Chrome (122+) lets an extension page create a
// credential whose rp.id is its own extension id, and no web page can ask for it. Only Chrome:
// Firefox ties an extension's RP id to its host permissions, which would put the passkey under a
// web domain, so Firefox keeps the password alone (`available()` is false there).
//
// Nothing here is a secret at rest: the credential id and the PRF salt are stored by the engine;
// the PRF output exists only between the prompt and the engine sealing or opening with it.

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

export function makePasskey(ext, { nav = globalThis.navigator, PKC = globalThis.PublicKeyCredential, loc = globalThis.location } = {}) {
  const rpId = ext && ext.runtime && ext.runtime.id;
  const isChromeExtension = !!loc && loc.protocol === 'chrome-extension:';
  if (!rpId || !isChromeExtension || !PKC || !nav || !nav.credentials) return null;

  const platformName = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '');
  const label = () => (/mac/i.test(platformName) ? 'Touch ID' : /win/i.test(platformName) ? 'Windows Hello' : 'your device’s screen lock');

  async function available() {
    if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    if (!(await PKC.isUserVerifyingPlatformAuthenticatorAvailable())) return false;
    // Chrome 133+ says whether PRF is there before anything is made; an older one is asked by
    // making the passkey (`register` refuses a credential without it).
    if (typeof PKC.getClientCapabilities === 'function') {
      try {
        const caps = await PKC.getClientCapabilities();
        if (caps && caps['extension:prf'] === false) return false;
      } catch { /* unknown: let register decide */ }
    }
    return true;
  }

  async function prf({ credentialId, salt }) {
    const cred = await nav.credentials.get({
      publicKey: {
        rpId,
        challenge: random(32),
        allowCredentials: [{ type: 'public-key', id: unb64u(credentialId), transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: unb64u(salt) } } },
      },
    });
    const out = cred && cred.getClientExtensionResults && cred.getClientExtensionResults().prf;
    const first = out && out.results && out.results.first;
    if (!first) throw new Error('this passkey does not support the PRF extension');
    return new Uint8Array(first);
  }

  async function register() {
    const salt = random(32);
    const cred = await nav.credentials.create({
      publicKey: {
        rp: { id: rpId, name: 'Rand Wallet' },
        user: { id: random(16), name: 'Rand Wallet', displayName: 'Rand Wallet' },
        challenge: random(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    const ext = cred && cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    if (!ext.prf || ext.prf.enabled === false) throw new Error(`${label()} here cannot derive a key (no PRF support), so it cannot unlock the wallet`);
    const made = { credentialId: b64u(cred.rawId), salt: b64u(salt) };
    // Some authenticators answer the PRF at creation; the rest are asked once more (a second
    // fingerprint) by the engine through `prf()`.
    const first = ext.prf.results && ext.prf.results.first;
    if (first) made.prf = new Uint8Array(first);
    return made;
  }

  return { available, label, register, prf };
}

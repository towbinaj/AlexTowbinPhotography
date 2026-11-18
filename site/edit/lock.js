// Face ID lock for the editor app (a passkey on this device; no server).
//
// "prf" mode (iPhone with iOS 18+, recent Chrome/Android): the passkey's PRF
// extension gives a secret only after Face ID; it derives an AES-GCM key that
// encrypts the GitHub key. Only the encrypted key is stored, so it can't be
// read from the device without Face ID.
// "gate" mode (passkey without PRF): Face ID must pass before the app opens,
// but the GitHub key is stored as before. The app says which mode is in use.
(function (root) {
  "use strict";
  const LOCK = "at-lock";
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(LOCK) || "null"); } catch { return null; } },
    set(v) { try { localStorage.setItem(LOCK, JSON.stringify(v)); return true; } catch { return false; } },
    del() { try { localStorage.removeItem(LOCK); } catch { /* ignore */ } },
  };

  async function available() {
    try {
      return !!(root.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch { return false; }
  }

  async function aesKey(prfSecret) {
    const base = await crypto.subtle.importKey("raw", prfSecret, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("at-editor github key v1") },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // Face ID check; returns the PRF secret when the passkey supports it.
  async function verify(lock) {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: "public-key", id: unb64(lock.id) }],
      userVerification: "required",
      timeout: 60000,
      ...(lock.salt ? { extensions: { prf: { eval: { first: unb64(lock.salt) } } } } : {}),
    } });
    if (!cred) throw new Error("Face ID was cancelled.");
    // Without a server we can't check signatures; we do require that the
    // passkey reports the person was verified (Face ID / passcode).
    const flags = new Uint8Array(cred.response.authenticatorData)[32];
    if (!(flags & 0x04)) throw new Error("Face ID didn't verify.");
    const r = cred.getClientExtensionResults();
    return r && r.prf && r.prf.results && r.prf.results.first ? r.prf.results.first : null;
  }

  async function seal(lock, secret, key) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(key));
    return { ...lock, mode: "prf", iv: b64(iv), ct: b64(ct) };
  }

  const api = {
    available,
    enabled: () => !!store.get(),
    mode: () => (store.get() || {}).mode || "",
    // Creates the passkey (Face ID prompt) and protects `key` with it.
    // Returns "prf" or "gate".
    async enable(key) {
      const salt = rand(32);
      const cred = await navigator.credentials.create({ publicKey: {
        rp: { name: "AT Editor" },
        user: { id: rand(16), name: "AT Editor", displayName: "Alex Towbin photo editor" },
        challenge: rand(32),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
        timeout: 60000,
        extensions: { prf: { eval: { first: salt } } },
      } });
      if (!cred) throw new Error("Face ID setup was cancelled.");
      let lock = { v: 1, id: b64(cred.rawId), salt: b64(salt), mode: "gate" };
      const ext = cred.getClientExtensionResults();
      let secret = ext && ext.prf && ext.prf.results && ext.prf.results.first;
      if (!secret && ext && ext.prf && ext.prf.enabled) secret = await verify(lock); // some devices only answer on sign-in
      if (secret) lock = await seal(lock, secret, key);
      else delete lock.salt;
      if (!store.set(lock)) throw new Error("This device couldn't save the lock.");
      return lock.mode;
    },
    // Face ID; returns the GitHub key in prf mode, or null in gate mode.
    async unlock() {
      const lock = store.get();
      if (!lock) return null;
      const secret = await verify(lock);
      if (lock.mode !== "prf") return null;
      if (!secret) throw new Error("This passkey didn't return its secret. Use “Reset” and connect again.");
      try {
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(lock.iv) }, await aesKey(secret), unb64(lock.ct));
        return dec.decode(pt);
      } catch { throw new Error("Couldn't decrypt the key with this passkey. Use “Reset” and connect again."); }
    },
    // New GitHub key while locked (Face ID prompt in prf mode).
    async rekey(key) {
      const lock = store.get();
      if (!lock || lock.mode !== "prf") return;
      const secret = await verify(lock);
      if (!secret) throw new Error("This passkey didn't return its secret.");
      store.set(await seal(lock, secret, key));
    },
    disable() { store.del(); },
  };
  root.EditLock = api;
})(window);

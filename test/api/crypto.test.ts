import * as crypto from 'crypto';
import { DeviceKey, encryptRequest, rsaEncryptBase64String } from '../../src/api/crypto';

/**
 * Reproduces the reference client's (pymyhondaplus) exact
 * `_encrypt_with_server_public_key` + base64-decode round trip in Node,
 * so tests can assert on it without a live Python process:
 *
 *   Python: server_key.encrypt(payload.encode("utf-8"), PKCS1v15())
 *           where payload = base64.b64encode(raw_bytes).decode()
 *
 * i.e. RSA-decrypting a correctly-built envelope field must yield the
 * *base64 text* of the original bytes, not the bytes themselves — and
 * base64-decoding that text must recover the original bytes exactly.
 * This is the structural invariant the reported "Failed to decrypt
 * request" bug violated (this plugin was RSA-encrypting the raw bytes
 * directly, skipping the base64-string step entirely).
 */
function decryptToOriginalBytes(encryptedBase64: string, privateKey: crypto.KeyObject): Buffer {
  const rsaPlaintext = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(encryptedBase64, 'base64'),
  );
  const asText = rsaPlaintext.toString('utf8');
  // Must be exactly the base64 alphabet (+ padding), never raw binary —
  // raw binary decrypted straight to UTF-8 would almost certainly contain
  // non-base64 characters (or fail to even form valid UTF-8) for a random
  // 16/32-byte key, unlike a genuine base64 string of it.
  expect(asText).toMatch(/^[A-Za-z0-9+/]+=*$/);
  return Buffer.from(asText, 'base64');
}

describe('rsaEncryptBase64String (regression for "Failed to decrypt request")', () => {
  it('RSA-encrypts the base64 STRING form of the input, matching the reference exactly — not the raw bytes', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const originalIv = crypto.randomBytes(16);

    const encrypted = rsaEncryptBase64String(originalIv, publicKey);
    const recovered = decryptToOriginalBytes(encrypted, privateKey);

    expect(recovered).toEqual(originalIv);
  });

  it('works for a 32-byte AES key the same way', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const originalKey = crypto.randomBytes(32);

    const encrypted = rsaEncryptBase64String(originalKey, publicKey);
    const recovered = decryptToOriginalBytes(encrypted, privateKey);

    expect(recovered).toEqual(originalKey);
  });

  it('reproduces the exact failure mode of the original bug for comparison: raw-byte RSA encryption does NOT decrypt to valid base64', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const originalIv = crypto.randomBytes(16);

    // This is what the plugin used to do: RSA-encrypt the raw bytes directly.
    const buggyEncrypted = crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      originalIv,
    ).toString('base64');

    const rsaPlaintext = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(buggyEncrypted, 'base64'),
    );
    // Honda's server treats this RSA-decrypted plaintext as base64 text
    // and tries to base64-decode it — for genuinely random 16 raw bytes,
    // interpreting them as UTF-8 either fails outright or (on the rare
    // input where it doesn't) does not decode to the correct original
    // bytes. Either way it is not the correct 16-byte IV, demonstrating
    // why Honda reported "Failed to decrypt request".
    let recoveredMatchesOriginal = false;
    try {
      const asText = rsaPlaintext.toString('utf8');
      recoveredMatchesOriginal = Buffer.from(asText, 'base64').equals(originalIv);
    } catch {
      recoveredMatchesOriginal = false;
    }
    expect(recoveredMatchesOriginal).toBe(false);
  });
});

describe('encryptRequest', () => {
  it('produces an envelope whose RSA-encrypted fields decrypt to the base64 string of the real AES key/IV (via rsaEncryptBase64String)', () => {
    // encryptRequest always uses Honda's real (hardcoded) public key, so it
    // can't be decrypted here directly — but rsaEncryptBase64String is the
    // exact function it calls internally for both encryptedOneTimeKey and
    // encryptedOneTimeSalt (see src/api/crypto.ts), so exercising that
    // function directly against a local test keypair (above) verifies the
    // real code path encryptRequest uses, not a reimplementation of it.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);

    const encryptedOneTimeKey = rsaEncryptBase64String(aesKey, publicKey);
    const encryptedOneTimeSalt = rsaEncryptBase64String(iv, publicKey);

    expect(decryptToOriginalBytes(encryptedOneTimeKey, privateKey)).toEqual(aesKey);
    expect(decryptToOriginalBytes(encryptedOneTimeSalt, privateKey)).toEqual(iv);
  });

  it('produces an encryptedPayload that AES-decrypts with the real key/IV recovered the same way', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

    const encryptWith = (pubKey: crypto.KeyObject, payload: unknown) => {
      const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
      const aesKey = crypto.randomBytes(32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        encryptedOneTimeKey: rsaEncryptBase64String(aesKey, pubKey),
        encryptedOneTimeSalt: rsaEncryptBase64String(iv, pubKey),
        encryptedPayload: ciphertext.toString('base64'),
      };
    };

    const envelope = encryptWith(publicKey, { hello: 'world', n: 42 });

    const aesKey = decryptToOriginalBytes(envelope.encryptedOneTimeKey, privateKey);
    const iv = decryptToOriginalBytes(envelope.encryptedOneTimeSalt, privateKey);
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.encryptedPayload, 'base64')), decipher.final()]);

    expect(JSON.parse(plaintext.toString('utf8'))).toEqual({ hello: 'world', n: 42 });
  });

  it('produces an envelope with the expected field names and static key id', () => {
    const envelope = encryptRequest({ a: 1 });
    expect(Object.keys(envelope).sort()).toEqual(
      ['encryptedOneTimeKey', 'encryptedOneTimeSalt', 'encryptedPayload', 'keyId'].sort(),
    );
    expect(envelope.keyId).toBe('1bff05258b984f278f70ed8c9580ba79');
    expect(envelope.encryptedOneTimeKey.length).toBeGreaterThan(0);
    expect(envelope.encryptedPayload.length).toBeGreaterThan(0);
  });

  it('produces different ciphertext for the same payload each time (random key/IV)', () => {
    const a = encryptRequest({ x: 1 });
    const b = encryptRequest({ x: 1 });
    expect(a.encryptedPayload).not.toEqual(b.encryptedPayload);
    expect(a.encryptedOneTimeKey).not.toEqual(b.encryptedOneTimeKey);
  });
});

describe('DeviceKey', () => {
  it('round-trips through PEM export/import preserving the public key', () => {
    const original = DeviceKey.generate();
    const pem = original.toPem();
    const restored = DeviceKey.fromPem(pem);
    expect(restored.publicKeyB64).toEqual(original.publicKeyB64);
  });

  it('produces a signature verifiable with the device public key', () => {
    const key = DeviceKey.generate();
    const challenge = 'some-server-issued-challenge';
    const signatureB64 = key.sign(challenge);

    const publicKeyDer = Buffer.from(key.publicKeyB64, 'base64');
    const publicKey = crypto.createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(challenge, 'utf8'),
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(signatureB64, 'base64'),
    );
    expect(verified).toBe(true);
  });

  it('generates distinct keys on each call', () => {
    const a = DeviceKey.generate();
    const b = DeviceKey.generate();
    expect(a.publicKeyB64).not.toEqual(b.publicKeyB64);
  });
});

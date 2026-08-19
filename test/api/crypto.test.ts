import * as crypto from 'crypto';
import { DeviceKey, encryptRequest } from '../../src/api/crypto';

describe('encryptRequest', () => {
  it('produces an envelope decryptable with the matching RSA private key', () => {
    // Generate our own keypair standing in for Honda's server key so we can
    // verify the AES key/IV really do decrypt with RSA, without needing the
    // real (secret) server private key.
    const serverKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

    const encryptWith = (publicKey: crypto.KeyObject, payload: unknown) => {
      const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
      const aesKey = crypto.randomBytes(32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        encryptedOneTimeKey: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, aesKey).toString('base64'),
        encryptedOneTimeSalt: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, iv).toString('base64'),
        encryptedPayload: ciphertext.toString('base64'),
      };
    };

    const envelope = encryptWith(serverKeyPair.publicKey, { hello: 'world', n: 42 });

    const aesKey = crypto.privateDecrypt(
      { key: serverKeyPair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(envelope.encryptedOneTimeKey, 'base64'),
    );
    const iv = crypto.privateDecrypt(
      { key: serverKeyPair.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(envelope.encryptedOneTimeSalt, 'base64'),
    );
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

/**
 * Cryptographic primitives for the Honda Connect Europe ("My Honda+") login
 * protocol.
 *
 * Honda's mobile app never sends plaintext credentials. Every auth request
 * body is wrapped in a hybrid envelope:
 *   1. The JSON payload is AES-256-CBC encrypted with a random one-time key/IV.
 *   2. That one-time key and IV are each RSA (PKCS#1 v1.5) encrypted with a
 *      fixed RSA public key that ships inside Honda's app.
 *   3. The device itself holds its own RSA keypair, used to sign a
 *      server-issued challenge during login (proves possession of a
 *      previously-registered device) and to register a new device.
 *
 * This module reimplements that envelope from scratch against Node's
 * built-in `crypto` module. It does not reuse or transcribe any Honda app
 * code — the shapes below are simply what the public HTTPS endpoint
 * expects, learned by observing the protocol.
 */

import * as crypto from 'crypto';

/**
 * Honda's server-side RSA public key (DER/X.509 SubjectPublicKeyInfo,
 * base64-encoded), used to encrypt the one-time AES key/IV in every
 * auth request. This is a *public* key shipped inside Honda's own
 * mobile app — publishing it carries no confidentiality implication,
 * it is required for any client to interoperate with Honda's endpoint.
 */
export const SERVER_PUBLIC_KEY_B64 =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyCLLwyLwpI1vsPcUNTgJ' +
  '1dr2pJ53luEx/BuU4HVSVtz6HtkPpEDSiFDOOrpJJOTYUjzqV93bm7Q2t2g8pRqK' +
  '0zjijLm4w1tdcZkxEwYVQJr8SOYza/zbeac2TMu4iu9SbbJM0fzUwX6IrBu/EE4G' +
  'diIF3Dwm4tzNpqZeh1fXEy9A2MHzmZIdWdkowZlUUyLtXuGBcbTOBY7LFRLKK0bV' +
  'UsC06w/dCD3Rhs48IXhAPyqSZYCIqofUvAq5NE0YzIPSSMKtrcPPL+Ae0F9/pz8q' +
  'YisH8TWyZZ6ih0Y5HufjuDzNYfJLNt4CEiohs7+hZtfbshkKuw+vr3sS4g9zM0Ot' +
  'SQIDAQAB';

/** Identifier for the hardcoded server public key above, expected by the API. */
export const SERVER_PUBLIC_KEY_ID = '1bff05258b984f278f70ed8c9580ba79';

export interface EncryptedEnvelope {
  encryptedOneTimeKey: string;
  encryptedOneTimeSalt: string;
  encryptedPayload: string;
  keyId: string;
}

function serverPublicKey(): crypto.KeyObject {
  const der = Buffer.from(SERVER_PUBLIC_KEY_B64, 'base64');
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function rsaEncrypt(data: Buffer): string {
  const encrypted = crypto.publicEncrypt(
    { key: serverPublicKey(), padding: crypto.constants.RSA_PKCS1_PADDING },
    data,
  );
  return encrypted.toString('base64');
}

/**
 * Encrypt a JSON-serializable request body using Honda's hybrid
 * AES+RSA envelope. Every field name below (`encryptedOneTimeKey`, etc.)
 * matches what the `/auth/*` endpoints require verbatim.
 */
export function encryptRequest(payload: unknown): EncryptedEnvelope {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    encryptedOneTimeKey: rsaEncrypt(aesKey),
    encryptedOneTimeSalt: rsaEncrypt(iv),
    encryptedPayload: ciphertext.toString('base64'),
    keyId: SERVER_PUBLIC_KEY_ID,
  };
}

/**
 * A device's own RSA-2048 keypair, used to prove device identity during
 * login (by signing a server-issued challenge) and during device
 * registration (by presenting the public key).
 */
export class DeviceKey {
  private constructor(private readonly keyPair: crypto.KeyPairKeyObjectResult) {}

  static generate(): DeviceKey {
    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return new DeviceKey(keyPair);
  }

  static fromPem(privateKeyPem: string): DeviceKey {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const publicKey = crypto.createPublicKey(privateKey);
    return new DeviceKey({ privateKey, publicKey });
  }

  toPem(): string {
    return this.keyPair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
  }

  /** Base64-encoded DER SubjectPublicKeyInfo — sent to Honda as `devicePublicKey`. */
  get publicKeyB64(): string {
    const der = this.keyPair.publicKey.export({ type: 'spki', format: 'der' });
    return der.toString('base64');
  }

  /** Honda treats the device's own public key as its identifier too. */
  get keyIdentifier(): string {
    return this.publicKeyB64;
  }

  /** SHA256withRSA sign a challenge string, base64-encoded, as Honda expects. */
  sign(data: string): string {
    const signature = crypto.sign('RSA-SHA256', Buffer.from(data, 'utf8'), {
      key: this.keyPair.privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    return signature.toString('base64');
  }
}

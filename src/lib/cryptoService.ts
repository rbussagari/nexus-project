import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, decodeUTF8, encodeUTF8 } from 'tweetnacl-util';
import { openDB, IDBPDatabase } from 'idb';
import { v4 as uuidv4 } from 'uuid';

/**
 * Interface for the stored security identity
 */
export interface Identity {
  deviceId: string;
  signKeyPair: {
    publicKey: string; // Base64 encoded
    privateKey: string; // Base64 encoded
  };
  boxKeyPair: {
    publicKey: string; // Base64 encoded
    privateKey: string; // Base64 encoded
  };
}

const DB_NAME = 'crypto-vault-db';
const STORE_NAME = 'identity';
const DB_VERSION = 1;

/**
 * Initializes the IndexedDB for secure key storage
 */
async function initDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    },
  });
}

/**
 * Generates or retrieves a persistent identity for a specific named slot
 */
export async function getIdentity(slot: string = 'current'): Promise<Identity> {
  const db = await initDB();
  const existing = await db.get(STORE_NAME, slot);

  if (existing) {
    return existing;
  }

  // Generate new identity
  // For demo personas, let's use readable node IDs
  const readableIds: Record<string, string> = {
    'alpha': 'NEXUS_ALPHA_01',
    'beta': 'NEXUS_BETA_02',
    'gamma': 'NEXUS_GAMMA_03',
    'delta': 'NEXUS_DELTA_04'
  };

  const deviceId = readableIds[slot] || uuidv4();
  const signKeyPair = nacl.sign.keyPair();
  const boxKeyPair = nacl.box.keyPair();

  const identity: Identity = {
    deviceId,
    signKeyPair: {
      publicKey: encodeBase64(signKeyPair.publicKey),
      privateKey: encodeBase64(signKeyPair.secretKey),
    },
    boxKeyPair: {
      publicKey: encodeBase64(boxKeyPair.publicKey),
      privateKey: encodeBase64(boxKeyPair.secretKey),
    },
  };

  await db.put(STORE_NAME, identity, slot);
  return identity;
}

/**
 * Encrypts a message using the recipient's public key (Curve25519)
 * Note: Uses our own private key to create a box.
 */
export async function encryptMessage(
  message: string,
  recipientPublicKeyB64: string,
  senderPrivateKeyB64: string
): Promise<string> {
  const messageUint8 = decodeUTF8(message);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const recipientPublicKey = decodeBase64(recipientPublicKeyB64);
  const senderPrivateKey = decodeBase64(senderPrivateKeyB64);

  const encrypted = nacl.box(
    messageUint8,
    nonce,
    recipientPublicKey,
    senderPrivateKey
  );

  const fullMessage = new Uint8Array(nonce.length + encrypted.length);
  fullMessage.set(nonce);
  fullMessage.set(encrypted, nonce.length);

  return encodeBase64(fullMessage);
}

/**
 * Decrypts a message using our private key and sender's public key
 */
export async function decryptMessage(
  cipherB64: string,
  senderPublicKeyB64: string,
  myPrivateKeyB64: string
): Promise<string | null> {
  const cipherWithNonce = decodeBase64(cipherB64);
  const nonce = cipherWithNonce.slice(0, nacl.box.nonceLength);
  const message = cipherWithNonce.slice(nacl.box.nonceLength);
  
  const senderPublicKey = decodeBase64(senderPublicKeyB64);
  const myPrivateKey = decodeBase64(myPrivateKeyB64);

  const decrypted = nacl.box.open(
    message,
    nonce,
    senderPublicKey,
    myPrivateKey
  );

  return decrypted ? encodeUTF8(decrypted) : null;
}

/**
 * Signs data using a private key (Ed25519)
 */
export function signMessage(data: string, privateKeyB64: string): string {
  const dataUint8 = decodeUTF8(data);
  const privateKey = decodeBase64(privateKeyB64);
  const signature = nacl.sign.detached(dataUint8, privateKey);
  return encodeBase64(signature);
}

/**
 * Verifies a signature against data and a public key (Ed25519)
 */
export function verifySignature(
  data: string,
  signatureB64: string,
  publicKeyB64: string
): boolean {
  const dataUint8 = decodeUTF8(data);
  const signature = decodeBase64(signatureB64);
  const publicKey = decodeBase64(publicKeyB64);
  return nacl.sign.detached.verify(dataUint8, signature, publicKey);
}

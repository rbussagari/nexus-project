import { db, Contact } from './db';

/**
 * Managing peer identities and their trust scores.
 */

export async function addContact(deviceId: string, publicKey: string): Promise<void> {
  const existing = await db.contacts.get(deviceId);
  
  await db.contacts.put({
    deviceId,
    publicKey,
    lastSeen: Date.now(),
    trustScore: existing ? existing.trustScore : 50, // Initial trust is neutral
    reputation: existing ? existing.reputation : 0,
    routingHops: existing ? existing.routingHops : 0,
    isVerified: existing ? existing.isVerified : false
  });
}

export async function updateLastSeen(deviceId: string): Promise<void> {
  const contact = await db.contacts.get(deviceId);
  if (contact) {
    contact.lastSeen = Date.now();
    await db.contacts.put(contact);
  }
}

export async function updateTrustScore(deviceId: string, delta: number): Promise<void> {
  const contact = await db.contacts.get(deviceId);
  if (contact) {
    contact.trustScore = Math.max(0, Math.min(100, contact.trustScore + delta));
    await db.contacts.put(contact);
  }
}

export async function getPeerIdentity(deviceId: string): Promise<Contact | undefined> {
  return await db.contacts.get(deviceId);
}

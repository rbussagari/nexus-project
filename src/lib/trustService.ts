import { db, Contact } from './db';

/**
 * Trust Layer: Updates the trust score of a peer based on interactions.
 */
export async function adjustTrustScore(deviceId: string, delta: number) {
  const contact = await db.contacts.get(deviceId);
  if (contact) {
    const newScore = Math.max(0, Math.min(100, contact.trustScore + delta));
    await db.contacts.update(deviceId, { trustScore: newScore });
    return newScore;
  }
  return 0;
}

/**
 * Reputation Layer: Updates community reputation.
 */
export async function adjustReputation(deviceId: string, delta: number) {
  const contact = await db.contacts.get(deviceId);
  if (contact) {
    const newRep = Math.max(0, contact.reputation + delta);
    await db.contacts.update(deviceId, { reputation: newRep });
    return newRep;
  }
  return 0;
}

/**
 * Decay function for reputation (simulation of time passing).
 */
export async function applyReputationDecay() {
  const contacts = await db.contacts.toArray();
  for (const contact of contacts) {
    const decayedRep = Math.floor(contact.reputation * 0.95); // 5% decay
    await db.contacts.update(contact.deviceId, { reputation: decayedRep });
  }
}

/**
 * Validates a relay path or packet based on trust thresholds.
 */
export async function isPeerTrusted(deviceId: string, minScore: number = 20) {
  const contact = await db.contacts.get(deviceId);
  return contact ? contact.trustScore >= minScore : false;
}

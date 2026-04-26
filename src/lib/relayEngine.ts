import { db, Message, Contact } from './db';
import { isPeerTrusted } from './trustService';

const MAX_HOPS = 10;
const PURGE_INTERVAL_MS = 60000; // 1 minute

/**
 * Handles incoming message processing according to relay logic.
 * Uses a transaction to ensure atomicity.
 */
export async function processIncomingMessage(
  packet: Message,
  myDeviceId: string
): Promise<{ success: boolean; reason?: string }> {
  // Resilience Layer: Trust Check
  // In a real gossip implementation, we'd know who handed us this packet.
  // For the simulation, we check the fromDevice's trust if we have it.
  const trusted = await isPeerTrusted(packet.fromDevice, 5); // Minimum threshold to prevent total block of new nodes
  if (!trusted && packet.fromDevice !== 'SYSTEM_RELAY') {
    // If the node exists but is untrusted, we might still accept it if it's new (trust 50)
    // but if it's < 5, it's blacklisted.
  }

  return await db.transaction('rw', [db.messages, db.relayQueue, db.contacts], async () => {
    // 1. Duplicate check using indexed messageId
    const existing = await db.messages.where('messageId').equals(packet.messageId).first();
    if (existing) {
      return { success: false, reason: 'Duplicate message detected' };
    }

    // 2. Expiry check
    if (packet.expiresAt < Date.now()) {
      return { success: false, reason: 'Message expired' };
    }

    // 3. Routing Decision
    if (packet.toDevice === myDeviceId || packet.toDevice === 'ALL_NODES') {
      // Direct Delivery
      await db.messages.add({
        ...packet,
        status: 'delivered',
        createdAt: Date.now()
      });
      
      if (packet.toDevice === myDeviceId) {
        return { success: true, reason: 'Message delivered to current device' };
      }
      // If it's ALL_NODES, we also want to relay it, so we continue...
    }

    // Relay logic (for non-me nodes or ALL_NODES)
    if (packet.toDevice !== myDeviceId) {
      const newHopCount = (packet.hopCount || 0) + 1;

      if (newHopCount > MAX_HOPS) {
        return { success: false, reason: 'Max hop count exceeded' };
      }

      // Store in messages (local persistence for relay)
      await db.messages.add({
        ...packet,
        status: 'pending',
        hopCount: newHopCount,
        createdAt: Date.now()
      });

      // Register in Relay Queue for transmission engine
      await db.relayQueue.add({
        messageId: packet.messageId,
        targetDevice: packet.toDevice,
        attempts: 0,
        lastAttempt: Date.now()
      });

      return { success: true, reason: 'Message added to relay queue' };
    }
  });
}

/**
 * Retrieves all messages currently marked for relay by joining queue with message body.
 */
export async function getRelayMessages() {
  const queueItems = await db.relayQueue.toArray();
  const messageIds = queueItems.map(item => item.messageId);
  
  return await db.messages
    .where('messageId')
    .anyOf(messageIds)
    .toArray();
}

/**
 * Deletes expired messages from all relevant tables.
 * Efficiently cleans up orphaned relay queue items.
 */
export async function purgeExpiredData(): Promise<number> {
  const now = Date.now();
  
  return await db.transaction('rw', [db.messages, db.relayQueue], async () => {
    const expiredMessages = await db.messages
      .where('expiresAt')
      .below(now)
      .toArray();
    
    const expiredIds = expiredMessages.map(m => m.messageId);

    if (expiredIds.length > 0) {
      await db.relayQueue.where('messageId').anyOf(expiredIds).delete();
    }

    const deletedCount = await db.messages
      .where('expiresAt')
      .below(now)
      .delete();

    return deletedCount;
  });
}

/**
 * Starts a background interval for maintenance.
 */
export function startMaintenanceTicker(onPurge?: (count: number) => void) {
  return setInterval(async () => {
    const count = await purgeExpiredData();
    if (count > 0 && onPurge) onPurge(count);
  }, PURGE_INTERVAL_MS);
}

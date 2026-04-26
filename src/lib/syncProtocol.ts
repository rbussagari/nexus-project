import { db, Message } from './db';
import { processIncomingMessage } from './relayEngine';

export interface SyncVector {
  messageIds: string[];
}

export interface VectorDelta {
  missingFromLocal: string[];
  missingFromRemote: string[];
}

/**
 * Generates an inventory vector of all local message IDs.
 * In a real-world scenario, this could be a Bloom filter or Merkle root.
 */
export async function generateSummaryVector(): Promise<SyncVector> {
  const messages = await db.messages.toArray();
  return {
    messageIds: messages.map(m => m.messageId)
  };
}

/**
 * Compares a remote inventory with the local one to determine discrepancies.
 */
export async function compareVectors(remoteVector: SyncVector): Promise<VectorDelta> {
  const localVector = await generateSummaryVector();
  const localSet = new Set(localVector.messageIds);
  const remoteSet = new Set(remoteVector.messageIds);

  const missingFromLocal = [...remoteSet].filter(id => !localSet.has(id));
  const missingFromRemote = [...localSet].filter(id => !remoteSet.has(id));

  return {
    missingFromLocal,
    missingFromRemote
  };
}

/**
 * Fetches full message objects for a list of IDs.
 * Used when a remote peer requests specific messages they are missing.
 */
export async function getMissingMessages(ids: string[]): Promise<Message[]> {
  if (ids.length === 0) return [];
  return await db.messages.where('messageId').anyOf(ids).toArray();
}

/**
 * Merges a batch of incoming messages into the local database.
 * Leverages the relay engine to ensure logic consistency (duplicates, expiry, routing).
 */
export async function mergeMessages(
  incomingMessages: Message[], 
  myDeviceId: string
): Promise<{ merged: number; rejected: number; details: string[] }> {
  let merged = 0;
  let rejected = 0;
  const details: string[] = [];

  for (const msg of incomingMessages) {
    const result = await processIncomingMessage(msg, myDeviceId);
    if (result.success) {
      merged++;
    } else {
      rejected++;
    }
    details.push(`${msg.messageId}: ${result.reason}`);
  }

  return { merged, rejected, details };
}

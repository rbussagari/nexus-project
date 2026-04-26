import { v4 as uuidv4 } from 'uuid';
import { db, Message } from './db';
import { getIdentity, encryptMessage } from './cryptoService';
import { processIncomingMessage } from './relayEngine';

/**
 * Encrypts and dispatches a direct message to a specific peer.
 * Recipient must exist in the contacts table to provide their public key.
 */
export async function sendDirectMessage(
  toDevice: string, 
  content: string
): Promise<{ success: boolean; reason?: string; messageId?: string }> {
  try {
    const identity = await getIdentity();
    let messageContent = content;
    
    if (toDevice !== 'ALL_NODES') {
      const recipient = await db.contacts.get(toDevice);
      if (!recipient) {
        return { success: false, reason: 'Recipient unknown (no public key found)' };
      }
      // End-to-end encryption using recipient's public key and our private key
      messageContent = await encryptMessage(
        content,
        recipient.publicKey,
        identity.boxKeyPair.privateKey
      );
    }

    const packet: Message = {
      messageId: uuidv4(),
      toDevice,
      fromDevice: identity.deviceId,
      type: toDevice === 'ALL_NODES' ? 'dm/broadcast' : 'dm/secure',
      content: messageContent,
      status: 'pending',
      expiresAt: Date.now() + 86400000, // 24-hour default ttl
      hopCount: 0,
      createdAt: Date.now()
    };

    const result = await processIncomingMessage(packet, identity.deviceId);
    
    return { 
      ...result, 
      messageId: packet.messageId 
    };
  } catch (error) {
    return { 
      success: false, 
      reason: error instanceof Error ? error.message : 'Encryption/Dispatch failure' 
    };
  }
}

import Dexie, { type Table } from 'dexie';

export interface Message {
  id?: number;
  messageId: string;
  toDevice: string;
  fromDevice: string;
  type: string;
  content: string;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  expiresAt: number;
  hopCount: number;
  createdAt: number;
}

export interface RelayQueueItem {
  id?: number;
  messageId: string;
  targetDevice: string;
  attempts: number;
  lastAttempt: number;
}

export interface Contact {
  deviceId: string;
  publicKey: string;
  lastSeen: number;
  trustScore: number;
  reputation: number;
  routingHops: number;
  isVerified: boolean;
}

export interface CommunityDrop {
  id?: number;
  content: string;
  type: 'alerts' | 'resources' | 'routes';
  location: {
    lat: number;
    lng: number;
  };
  timestamp: number;
  expiresAt: number;
  authorReputation?: number;
}

export interface Session {
  sessionId: string;
  partnerDevice: string;
  status: 'active' | 'closed' | 'expired';
  lastSync: number;
  protocolVersion: string;
}

export class OfflineMessagingDB extends Dexie {
  messages!: Table<Message>;
  relayQueue!: Table<RelayQueueItem>;
  contacts!: Table<Contact>;
  communityDrops!: Table<CommunityDrop>;
  sessions!: Table<Session>;

  constructor(name: string = 'OfflineMessagingDB') {
    super(name);
    this.version(3).stores({
      messages: '++id, messageId, toDevice, fromDevice, type, status, expiresAt, createdAt',
      relayQueue: '++id, messageId, targetDevice, attempts',
      contacts: 'deviceId, publicKey, lastSeen, trustScore, reputation, isVerified',
      communityDrops: '++id, type, timestamp, expiresAt',
      sessions: 'sessionId, partnerDevice, status, lastSync'
    });
  }
}

// Default export database
export let db = new OfflineMessagingDB();

/**
 * Re-initializes the database with a specific name for node simulation
 */
export async function switchDatabaseNode(nodeId: string) {
  if (db.isOpen()) {
    await db.close();
  }
  db = new OfflineMessagingDB(`NEXUS_NODE_${nodeId.toUpperCase()}`);
  await db.open();
}

// Helper functions
export async function addMessage(message: Omit<Message, 'createdAt'>) {
  return await db.messages.add({
    ...message,
    createdAt: Date.now()
  });
}

export async function getPendingMessages() {
  return await db.messages
    .where('status')
    .equals('pending')
    .toArray();
}

export async function addToRelayQueue(relayItem: Omit<RelayQueueItem, 'lastAttempt' | 'attempts'>) {
  return await db.relayQueue.add({
    ...relayItem,
    attempts: 0,
    lastAttempt: Date.now()
  });
}

export async function getContacts() {
  return await db.contacts.toArray();
}

export async function upsertContact(contact: Contact) {
  return await db.contacts.put(contact);
}

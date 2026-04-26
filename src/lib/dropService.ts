import { db, CommunityDrop } from './db';

/**
 * Creates a public community drop at a specific location.
 * Encodes drop data for QR distribution.
 */
export async function createDrop(
  content: string, 
  type: 'alerts' | 'resources' | 'routes',
  location: { lat: number; lng: number },
  ttlMs: number = 86400000 // 24h default
): Promise<{ qrData: string; drop: CommunityDrop }> {
  const drop: CommunityDrop = {
    content,
    type,
    location,
    timestamp: Date.now(),
    expiresAt: Date.now() + ttlMs
  };

  const id = await db.communityDrops.add(drop);
  const dropWithId = { ...drop, id: id as number };

  // QR representation of the drop
  const qrData = JSON.stringify({
    type: 'community_drop',
    payload: dropWithId
  });

  return { qrData, drop: dropWithId };
}

/**
 * Parses and stores a drop encountered via QR.
 */
export async function scanDrop(qrData: string): Promise<boolean> {
  try {
    const data = JSON.parse(qrData);
    if (data.type !== 'community_drop') return false;

    const drop: CommunityDrop = data.payload;
    if (drop.expiresAt < Date.now()) return false;

    await db.communityDrops.put(drop);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Returns all active community drops.
 */
export async function getActiveDrops(): Promise<CommunityDrop[]> {
  return await db.communityDrops
    .where('expiresAt')
    .above(Date.now())
    .toArray();
}

import { db, Message } from './db';
import { mergeMessages } from './syncProtocol';

/**
 * Exports all messages or specific set as a JSON file.
 */
export async function exportMessages(): Promise<string> {
  const allMessages = await db.messages.toArray();
  const data = JSON.stringify({
    version: '1.0',
    timestamp: Date.now(),
    messages: allMessages
  }, null, 2);

  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = `mesh_backup_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  
  return data;
}

/**
 * Imports messages from a JSON file and merges them using the sync protocol.
 */
export async function importMessages(
  file: File, 
  myDeviceId: string
): Promise<{ success: boolean; merged: number; rejected: number; error?: string }> {
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.messages || !Array.isArray(data.messages)) {
      return { success: false, merged: 0, rejected: 0, error: 'Invalid file format' };
    }

    const result = await mergeMessages(data.messages, myDeviceId);
    return { success: true, ...result };
  } catch (err) {
    return { 
      success: false, 
      merged: 0, 
      rejected: 0, 
      error: err instanceof Error ? err.message : 'Import failed' 
    };
  }
}

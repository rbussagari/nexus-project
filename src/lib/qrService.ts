/**
 * Utilities for chunking large JSON payloads for QR transfer.
 */

export interface QRChunk {
  t: string; // total chunks
  i: number; // index
  p: string; // payload
  s: string; // session id
}

/**
 * Splits a string into chunks small enough for a high-density QR code.
 */
export function chunkPayload(data: string, maxChunkSize: number = 800): string[] {
  const sessionId = Math.random().toString(36).substring(7);
  const chunks: string[] = [];
  
  for (let i = 0; i < data.length; i += maxChunkSize) {
    chunks.push(data.substring(i, i + maxChunkSize));
  }

  const total = chunks.length;
  return chunks.map((p, i) => JSON.stringify({
    t: total.toString(),
    i,
    p,
    s: sessionId
  }));
}

/**
 * Reassembles chunks back into a single payload.
 */
export class QRReassembler {
  private sessions: Record<string, Record<number, string>> = {};

  addChunk(chunkJson: string): string | null {
    try {
      const chunk: QRChunk = JSON.parse(chunkJson);
      if (!this.sessions[chunk.s]) {
        this.sessions[chunk.s] = {};
      }
      
      this.sessions[chunk.s][chunk.i] = chunk.p;

      const total = parseInt(chunk.t);
      const currentCount = Object.keys(this.sessions[chunk.s]).length;

      if (currentCount === total) {
        // Reassemble
        let full = '';
        for (let j = 0; j < total; j++) {
          full += this.sessions[chunk.s][j];
        }
        delete this.sessions[chunk.s];
        return full;
      }
    } catch (e) {
      console.error('Invalid chunk format', e);
    }
    return null;
  }
}

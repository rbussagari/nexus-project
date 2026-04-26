/**
 * QR-based live streaming protocol for data exchange.
 * Implements a chunked frame system with ACK logic.
 */

export interface ChatFrame {
  sid: string; // Session ID
  seq: number; // Sequence number
  total: number;
  data: string;
  ack?: number; // Acknowledged sequence
}

export class QRChatProtocol {
  private sessionId: string;
  private currentSeq: number = 0;
  private totalChunks: number = 0;
  private chunks: string[] = [];
  private lastReceivedSeq: number = -1;

  constructor() {
    this.sessionId = Math.random().toString(36).substring(7);
  }

  /**
   * Prepares a message for streaming.
   */
  prepareStream(message: string, chunkSize: number = 200) {
    this.chunks = [];
    for (let i = 0; i < message.length; i += chunkSize) {
      this.chunks.push(message.substring(i, i + chunkSize));
    }
    this.totalChunks = this.chunks.length;
    this.currentSeq = 0;
  }

  /**
   * Generates the current frame to display as QR.
   */
  getCurrentFrame(): string {
    const frame: ChatFrame = {
      sid: this.sessionId,
      seq: this.currentSeq,
      total: this.totalChunks,
      data: this.chunks[this.currentSeq] || '',
      ack: this.lastReceivedSeq
    };
    return JSON.stringify(frame);
  }

  /**
   * Processes a received frame from the peer.
   * Advances our own stream if the peer has acknowledged our previous frame.
   */
  processFrame(frameJson: string): { type: 'DATA' | 'ACK'; progress: number; data?: string } | null {
    try {
      const frame: ChatFrame = JSON.parse(frameJson);
      
      // Handle ACK from peer for our outgoing stream
      if (frame.ack !== undefined && frame.ack === this.currentSeq) {
        if (this.currentSeq < this.totalChunks - 1) {
          this.currentSeq++;
        }
      }

      // Handle incoming data
      if (frame.seq === this.lastReceivedSeq + 1) {
        this.lastReceivedSeq = frame.seq;
        return {
          type: 'DATA',
          progress: (this.lastReceivedSeq + 1) / frame.total,
          data: frame.data
        };
      }

      return { type: 'ACK', progress: (this.currentSeq + 1) / this.totalChunks };
    } catch (e) {
      return null;
    }
  }

  reset() {
    this.currentSeq = 0;
    this.chunks = [];
    this.lastReceivedSeq = -1;
  }
}

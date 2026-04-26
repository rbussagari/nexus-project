/**
 * BLE Service Implementation
 * Since we are in a web environment, we use the Web Bluetooth API as a reference.
 * In a Capacitor environment, this would use @capacitor-community/bluetooth-le.
 */

export interface BLEPeer {
  id: string;
  name: string;
}

export class BLEService {
  private static instance: BLEService;
  private onReceiveCallback: ((data: string) => void) | null = null;

  private constructor() {}

  static getInstance() {
    if (!BLEService.instance) {
      BLEService.instance = new BLEService();
    }
    return BLEService.instance;
  }

  /**
   * Starts scanning for nearby BLE devices.
   */
  async startScan(): Promise<BLEPeer[]> {
    console.log('Starting BLE scan...');
    // Real Web Bluetooth requires user interaction
    // Here we return a mock for UI development
    return [
      { id: 'ble_001', name: 'MeshNode_A' },
      { id: 'ble_002', name: 'MeshNode_B' }
    ];
  }

  /**
   * Connects to a specific device.
   */
  async connectToDevice(deviceId: string): Promise<boolean> {
    console.log(`Connecting to ${deviceId}...`);
    // Logic for pairing and GATT connection
    return true;
  }

  /**
   * Sends JSON payload over BLE, handling chunking internally.
   */
  async sendData(payload: string): Promise<void> {
    console.log('Sending data payload over BLE:', payload);
    // Logic for writing to characteristics
  }

  /**
   * Registers a callback for incoming messages.
   */
  onReceive(callback: (data: string) => void) {
    this.onReceiveCallback = callback;
  }

  /**
   * Simulates receiving data (for testing purposes).
   */
  simulateReceive(data: string) {
    if (this.onReceiveCallback) {
      this.onReceiveCallback(data);
    }
  }
}

export const ble = BLEService.getInstance();

import { EventEmitter } from "node:events";
import net from "node:net";

/** Parsed JSON message received from FXServer. Always has a `type` field. */
export interface FxServerMessage {
  type: string;
  [key: string]: unknown;
}

export interface FxServerIpcEvents {
  message: [msg: FxServerMessage];
  connected: [];
  disconnected: [];
  error: [err: Error];
}

const HEADER_SIZE = 4;
const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 10_000;

/**
 * IPC client for communicating with FXServer via a Windows named pipe.
 *
 * Wire protocol (from FxDK `SdkIpc.cpp`):
 * - Transport: `\\.\pipe\cfx-fxdk-fxserver-ipc-{instanceId}`
 * - Framing: `[4-byte uint32LE length][JSON payload]`
 * - Bidirectional JSON messages with at minimum a `type` field
 *
 * @example
 * ```ts
 * const ipc = new FxServerIpc('my-instance-123');
 * ipc.on('message', (msg) => console.log(msg));
 * await ipc.connect();
 * ipc.send({ type: 'command', command: 'restart myresource' });
 * ```
 */
export class FxServerIpc extends EventEmitter<FxServerIpcEvents> {
  private readonly pipePath: string;
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private connected = false;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_MS;

  /** The FXServer instance ID this client targets. */
  readonly instanceId: string;

  constructor(instanceId: string) {
    super();
    this.instanceId = instanceId;
    this.pipePath = `\\\\.\\pipe\\cfx-fxdk-fxserver-ipc-${instanceId}`;
  }

  /**
   * Connect to the FXServer named pipe.
   * Resolves once the connection is established, rejects on initial failure.
   * Enables automatic reconnection on disconnect.
   */
  connect(): Promise<void> {
    this.shouldReconnect = true;
    return this.doConnect();
  }

  /**
   * Gracefully disconnect and stop reconnection attempts.
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.destroySocket();
  }

  /**
   * Send a JSON message to FXServer.
   * @throws If not currently connected.
   */
  send(msg: object): void {
    if (!this.socket || !this.connected) {
      throw new Error("FxServerIpc: not connected");
    }
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, "utf8");
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(payload.length, 0);
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Whether the pipe is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  // ── internal ──────────────────────────────────────────────────────

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.destroySocket();
      this.buffer = Buffer.alloc(0);

      const socket = net.createConnection(this.pipePath);
      this.socket = socket;

      socket.once("connect", () => {
        this.connected = true;
        this.reconnectDelay = INITIAL_RECONNECT_MS;
        this.emit("connected");
        resolve();
      });

      socket.on("data", (chunk: Buffer) => {
        this.onData(chunk);
      });

      socket.once("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) {
          this.emit("disconnected");
        }
        this.scheduleReconnect();
      });

      socket.once("error", (err: Error) => {
        if (!this.connected) {
          // First connection attempt failed
          reject(err);
        }
        this.emit("error", err);
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Drain as many complete frames as possible
    while (this.buffer.length >= HEADER_SIZE) {
      const payloadLength = this.buffer.readUInt32LE(0);
      const totalLength = HEADER_SIZE + payloadLength;

      if (this.buffer.length < totalLength) {
        break; // Incomplete frame — wait for more data
      }

      const jsonBytes = this.buffer.subarray(HEADER_SIZE, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      try {
        const msg = JSON.parse(jsonBytes.toString("utf8")) as FxServerMessage;
        this.emit("message", msg);
      } catch (err) {
        this.emit("error", new Error(`FxServerIpc: failed to parse message: ${err}`));
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.clearReconnectTimer();

    this.reconnectTimer = setTimeout(() => {
      this.doConnect().catch((err) => {
        this.emit("error", err);
        // Exponential backoff, capped
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private destroySocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }
}

export default FxServerIpc;

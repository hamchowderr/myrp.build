import { EventEmitter } from "node:events";
import net from "node:net";
import { decode, encode } from "@msgpack/msgpack";

/**
 * SP (Scalability Protocols) pair1 handshake header.
 * `\x00SP\x00` (4 bytes magic) + `\x00\x11\x00\x00` (pair1 protocol ID 0x0011, big-endian).
 */
const SP_HANDSHAKE = Buffer.from([0x00, 0x53, 0x50, 0x00, 0x00, 0x11, 0x00, 0x00]);

const HEADER_SIZE = 4; // 4-byte big-endian size prefix

type HandlerFn = (...args: unknown[]) => unknown;

interface LauncherTalkEvents {
  connected: [];
  disconnected: [];
  error: [err: Error];
}

/**
 * IPC bridge between the SDK host (FiveM Studio) and the game process,
 * mirroring FxDK's `LauncherIPC` (nng pair1 + msgpack).
 *
 * Wire protocol:
 * - Transport: nng pair1 over `ipc://cfx_sv_{prefix}` → named pipe `\\.\pipe\cfx_sv_{prefix}`
 * - SP handshake: 8-byte header exchanged on connect
 * - Framing: `[4-byte big-endian size][msgpack payload]`
 * - Payload: msgpack array `[name: string, ...args: any[]]`
 *
 * This implementation connects via the Node.js `net` module to the named pipe
 * using the SP wire format, so no native nng addon is required.
 *
 * @example
 * ```ts
 * const talk = new LauncherTalk('my-prefix');
 * talk.bind('greeting', (name: string) => console.log(`Hello ${name}`));
 * await talk.listen();
 * talk.call('ready', true);
 * ```
 */
export class LauncherTalk extends EventEmitter<LauncherTalkEvents> {
  private readonly pipePath: string;
  private readonly handlers = new Map<string, HandlerFn>();
  private socket: net.Socket | null = null;
  private server: net.Server | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private handshakeBuffer: Buffer = Buffer.alloc(0);

  /** The IPC prefix used for the named pipe path. */
  readonly prefix: string;

  /** Path to nng.dll for future Koffi-based transport (reserved). */
  readonly nngDllPath?: string;

  /**
   * @param prefix  The IPC prefix — pipe will be `\\.\pipe\cfx_sv_{prefix}`
   * @param nngDllPath  Reserved for future Koffi-based nng.dll transport (unused)
   */
  constructor(prefix: string, nngDllPath?: string) {
    super();
    this.prefix = prefix;
    this.nngDllPath = nngDllPath;
    this.pipePath = `\\\\.\\pipe\\cfx_sv_${prefix}`;
  }

  /**
   * Start listening as a pair1 server on the named pipe.
   * Resolves when the pipe server is ready to accept connections.
   */
  listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.attachSocket(socket, false);
      });

      server.on("error", (err) => {
        reject(err);
        this.emit("error", err);
      });

      server.listen(this.pipePath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  /**
   * Dial (connect to) an existing pair1 server on the named pipe.
   * Resolves once connected and SP handshake is sent.
   */
  dial(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);

      socket.once("connect", () => {
        this.attachSocket(socket, true);
        resolve();
      });

      socket.once("error", (err) => {
        reject(err);
        this.emit("error", err);
      });
    });
  }

  /**
   * Send an RPC call to the remote end.
   * @param name  The RPC method name.
   * @param args  Arguments to pass.
   */
  call(name: string, ...args: unknown[]): void {
    if (!this.socket) {
      throw new Error("LauncherTalk: not connected");
    }
    const payload = Buffer.from(encode([name, ...args]));
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32BE(payload.length, 0);
    this.socket.write(Buffer.concat([header, payload]));
  }

  /**
   * Register a handler for incoming RPC calls.
   * @param name     The RPC method name to handle.
   * @param handler  Callback invoked with the decoded arguments.
   */
  bind(name: string, handler: HandlerFn): void {
    this.handlers.set(name, handler);
  }

  /**
   * Process any pending received messages synchronously.
   * Call this periodically (e.g., from a frame loop) to dispatch handlers.
   *
   * Note: In this Node.js implementation, messages are dispatched immediately
   * on the `data` event, so `runFrame()` is provided for API compatibility
   * with the C++ poll-based FxDK design. It is a no-op.
   */
  runFrame(): void {
    // No-op — Node.js event loop dispatches automatically
  }

  /**
   * Close the connection and stop the server (if listening).
   */
  close(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.handshakeBuffer = Buffer.alloc(0);
  }

  // ── internal ──────────────────────────────────────────────────────

  private attachSocket(socket: net.Socket, isInitiator: boolean): void {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.handshakeBuffer = Buffer.alloc(0);

    // Send our SP handshake immediately
    socket.write(SP_HANDSHAKE);

    socket.on("data", (chunk: Buffer) => {
      if (!this.handshakeDone) {
        this.processHandshake(chunk);
      } else {
        this.onData(chunk);
      }
    });

    socket.once("close", () => {
      this.handshakeDone = false;
      this.emit("disconnected");
    });

    socket.once("error", (err) => {
      this.emit("error", err);
    });

    // If we're the initiator and handshake is zero-length from remote,
    // the remote's handshake bytes will arrive via data event.
    // For server-accepted sockets, same applies.
    void isInitiator;
  }

  private processHandshake(chunk: Buffer): void {
    this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);

    if (this.handshakeBuffer.length >= SP_HANDSHAKE.length) {
      const peerHandshake = this.handshakeBuffer.subarray(0, SP_HANDSHAKE.length);

      // Validate magic bytes (first 4 bytes: \x00SP\x00)
      if (
        peerHandshake[0] !== 0x00 ||
        peerHandshake[1] !== 0x53 ||
        peerHandshake[2] !== 0x50 ||
        peerHandshake[3] !== 0x00
      ) {
        this.emit("error", new Error("LauncherTalk: invalid SP handshake magic"));
        this.socket?.destroy();
        return;
      }

      // Validate pair1 protocol ID (bytes 4-5 should be 0x0011)
      const peerProtocol = (peerHandshake[4] << 8) | peerHandshake[5];
      if (peerProtocol !== 0x0011) {
        this.emit(
          "error",
          new Error(
            `LauncherTalk: unexpected SP protocol 0x${peerProtocol.toString(16)}, expected pair1 (0x0011)`,
          ),
        );
        this.socket?.destroy();
        return;
      }

      this.handshakeDone = true;
      this.emit("connected");

      // Any leftover bytes after the handshake are message data
      const remainder = this.handshakeBuffer.subarray(SP_HANDSHAKE.length);
      this.handshakeBuffer = Buffer.alloc(0);

      if (remainder.length > 0) {
        this.onData(remainder);
      }
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Drain complete frames
    while (this.buffer.length >= HEADER_SIZE) {
      const payloadLength = this.buffer.readUInt32BE(0);
      const totalLength = HEADER_SIZE + payloadLength;

      if (this.buffer.length < totalLength) {
        break; // Incomplete frame
      }

      const payloadBytes = this.buffer.subarray(HEADER_SIZE, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      try {
        const decoded = decode(payloadBytes) as unknown[];
        if (!Array.isArray(decoded) || decoded.length < 1 || typeof decoded[0] !== "string") {
          this.emit(
            "error",
            new Error("LauncherTalk: malformed message — expected [name, ...args]"),
          );
          continue;
        }

        const [name, ...args] = decoded as [string, ...unknown[]];
        const handler = this.handlers.get(name);
        if (handler) {
          try {
            handler(...args);
          } catch (err) {
            this.emit("error", new Error(`LauncherTalk: handler '${name}' threw: ${err}`));
          }
        }
      } catch (err) {
        this.emit("error", new Error(`LauncherTalk: failed to decode msgpack: ${err}`));
      }
    }
  }
}

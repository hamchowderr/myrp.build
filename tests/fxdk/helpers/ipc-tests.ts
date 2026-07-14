/**
 * FxDK manual-test group: FxServerIpc (named pipe) + LauncherTalk (SP wire).
 *
 * Extracted verbatim from tests/fxdk/test-fxdk.ts (behavior-preserving split).
 * Run via the test-fxdk.ts runner: `npx tsx tests/fxdk/test-fxdk.ts`.
 */

// ─── Test 2: FxServerIpc (named pipe loopback) ──────────────────────────────
export async function testFxServerIpc() {
  console.log("\n═══ Test 2: FxServerIpc (pipe loopback) ═══");

  const net = await import("node:net");
  const { FxServerIpc } = await import("../../../src/main/fxdk/fxserver-ipc");

  const TEST_ID = `myrp-build-test-${Date.now()}`;
  const pipePath = `\\\\.\\pipe\\cfx-fxdk-fxserver-ipc-${TEST_ID}`;

  // Create a mock server that echoes messages
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) break;
        const payload = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);

        // Echo back with type: "echo"
        const msg = JSON.parse(payload.toString("utf8"));
        const response = JSON.stringify({ type: "echo", original: msg });
        const respBuf = Buffer.from(response, "utf8");
        const header = Buffer.alloc(4);
        header.writeUInt32LE(respBuf.length, 0);
        socket.write(Buffer.concat([header, respBuf]));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(pipePath, resolve));

  const ipc = new FxServerIpc(TEST_ID);

  try {
    // 2a: Connect
    await ipc.connect();
    console.log(`  [PASS] connect() to ${pipePath}`);
    console.log(`  [${ipc.isConnected() ? "PASS" : "FAIL"}] isConnected() = true`);

    // 2b: Send and receive
    const received = await new Promise<object>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for echo")), 3000);
      ipc.once("message", (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      });
      ipc.send({ type: "test", data: "hello" });
    });
    console.log(`  [PASS] send/receive roundtrip: ${JSON.stringify(received)}`);

    // 2c: Disconnect
    ipc.disconnect();
    console.log(`  [PASS] disconnect()`);
    console.log(
      `  [${!ipc.isConnected() ? "PASS" : "FAIL"}] isConnected() = false after disconnect`,
    );
  } catch (err) {
    console.log(`  [FAIL] FxServerIpc error: ${err}`);
  } finally {
    ipc.disconnect();
    server.close();
  }
}

// ─── Test 3: LauncherTalk (SP wire format loopback) ─────────────────────────
export async function testLauncherTalk() {
  console.log("\n═══ Test 3: LauncherTalk (SP pair1 loopback) ═══");

  const { LauncherTalk } = await import("../../../src/main/fxdk/launcher-talk");

  const PREFIX = `fivem_studio_test_${Date.now()}`;

  const serverTalk = new LauncherTalk(PREFIX);
  const clientTalk = new LauncherTalk(PREFIX);

  try {
    // 3a: Server listens
    await serverTalk.listen();
    console.log("  [PASS] server.listen()");

    // 3b: Bind handler on server
    let receivedArgs: unknown[] = [];
    serverTalk.bind("ping", (...args: unknown[]) => {
      receivedArgs = args;
    });

    // 3c: Client dials
    await clientTalk.dial();

    // Wait for SP handshake
    await new Promise<void>((resolve) => {
      serverTalk.once("connected", resolve);
      // If already connected, resolve immediately
      setTimeout(resolve, 500);
    });
    console.log("  [PASS] client.dial() + SP handshake");

    // 3d: Client sends RPC call
    clientTalk.call("ping", "hello", 42);

    // Give it a moment to process
    await new Promise((r) => setTimeout(r, 200));

    const argsOk =
      receivedArgs.length === 2 && receivedArgs[0] === "hello" && receivedArgs[1] === 42;
    console.log(
      `  [${argsOk ? "PASS" : "FAIL"}] client.call('ping', 'hello', 42) → server received: ${JSON.stringify(receivedArgs)}`,
    );

    // 3e: Server sends back to client
    let clientReceived: unknown[] = [];
    clientTalk.bind("pong", (...args: unknown[]) => {
      clientReceived = args;
    });
    serverTalk.call("pong", "world", 99);

    await new Promise((r) => setTimeout(r, 200));

    const clientOk =
      clientReceived.length === 2 && clientReceived[0] === "world" && clientReceived[1] === 99;
    console.log(
      `  [${clientOk ? "PASS" : "FAIL"}] server.call('pong', 'world', 99) → client received: ${JSON.stringify(clientReceived)}`,
    );
  } catch (err) {
    console.log(`  [FAIL] LauncherTalk error: ${err}`);
  } finally {
    clientTalk.close();
    serverTalk.close();
    console.log("  [PASS] close()");
  }
}

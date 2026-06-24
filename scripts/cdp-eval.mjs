// Dev helper: evaluate a JS expression in the running Electron renderer over CDP.
// Usage: node scripts/cdp-eval.mjs "<expression>"
// Node 22 global WebSocket. Picks the localhost:5173 page target.
const PORT = process.env.CDP_PORT || "9222";
const expr = process.argv[2];
if (!expr) {
  console.error('usage: node scripts/cdp-eval.mjs "<expression>"');
  process.exit(2);
}

const res = await fetch(`http://127.0.0.1:${PORT}/json`);
const targets = await res.json();
const page =
  targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url || "")) ||
  targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page target found");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
  }
});

await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
const out = await send("Runtime.evaluate", {
  expression: `(async () => { return (${expr}); })()`,
  awaitPromise: true,
  returnByValue: true,
});
if (out.result?.exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(out.result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(out.result?.result?.value ?? out.result, null, 2));
ws.close();
process.exit(0);

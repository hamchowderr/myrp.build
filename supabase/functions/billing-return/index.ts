// billing-return — the post-Checkout landing page (ok7 / fivem-studio-1tj).
//
// Stripe Checkout requires http(s) success/cancel URLs, but FiveM Studio is a
// desktop app with no website. This function serves a minimal, on-brand HTML page
// telling the user to return to the app. The subscription itself is activated by
// the stripe-webhook regardless of this page. No auth (Stripe redirects here via a
// plain browser GET) — verify_jwt=false.
//
// URLs (set as secrets): STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL point here with
//   ?status=success | ?status=cancel
import "@supabase/functions-js/edge-runtime.d.ts";

const page = (ok: boolean) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>myRP.build — ${ok ? "Subscription Active" : "Checkout Canceled"}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background:#0a0a0b; color:#e7e7ea; }
  .card { width:min(420px,92vw); padding:40px 32px; text-align:center;
    background:#141416; border:1px solid #26262b; border-radius:16px;
    box-shadow:0 12px 40px rgba(0,0,0,.5); }
  .badge { width:56px; height:56px; margin:0 auto 20px; border-radius:50%;
    display:grid; place-items:center; font-size:28px;
    background:${ok ? "rgba(52,199,89,.12)" : "rgba(255,159,10,.12)"};
    color:${ok ? "#34c759" : "#ff9f0a"}; }
  h1 { font-size:20px; margin:0 0 8px; font-weight:650; }
  p { margin:0; font-size:14px; line-height:1.5; color:#a1a1aa; }
  .hint { margin-top:24px; font-size:12px; color:#71717a; }
</style></head>
<body>
  <div class="card">
    <div class="badge">${ok ? "✓" : "↩"}</div>
    <h1>${ok ? "Subscription active 🎉" : "Checkout canceled"}</h1>
    <p>${
      ok
        ? "Your subscription is active. You can close this tab and return to myRP.build — your plan will update automatically."
        : "No charge was made. You can close this tab and return to myRP.build whenever you're ready."
    }</p>
    <p class="hint">You can safely close this window.</p>
  </div>
</body></html>`;

Deno.serve((req) => {
  const status = new URL(req.url).searchParams.get("status");
  const ok = status !== "cancel";
  return new Response(page(ok), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
});

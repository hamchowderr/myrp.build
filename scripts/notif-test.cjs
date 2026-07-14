// Standalone notification diagnostic. Run with:
//   npx electron scripts/notif-test.cjs
// Uses the SAME AppUserModelID as the app so it leans on the installed
// Start Menu shortcut's registration. Writes results to a temp log so the
// outcome is readable even if stdout isn't attached.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, Notification } = require("electron");

const OUT = path.join(os.tmpdir(), "myrp-notif-test.log");
const W = (m) => {
  try {
    fs.appendFileSync(OUT, `${new Date().toISOString()} ${m}\n`);
  } catch {}
  console.log(m);
};

fs.writeFileSync(OUT, ""); // truncate
app.setAppUserModelId("com.otakusolutions.myrp-build");

app.whenReady().then(() => {
  const supported = Notification.isSupported();
  W(`isSupported=${supported}`);
  if (!supported) {
    W("RESULT=NOT_SUPPORTED");
    app.quit();
    return;
  }
  const n = new Notification({
    title: "myRP.build — notification test",
    body: "If you can see this toast, notifications work.",
    silent: false,
  });
  n.on("show", () => W("EVENT=show (delivered to Action Center)"));
  n.on("failed", (_e, err) => W(`EVENT=failed err=${err}`));
  n.on("click", () => W("EVENT=click"));
  n.show();
  W("show()=called");
  setTimeout(() => {
    W("RESULT=done (quitting)");
    app.quit();
  }, 9000);
});

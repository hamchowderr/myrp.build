// E42 game-frame pipeline diagnostic (fivem-studio-uc3). Run with:
//   npx electron scripts/gameframe-test.cjs
// Exercises the ONLY Electron API in the game-view hot path —
// nativeImage.createFromBitmap(BGRA) -> toJPEG -> base64 — to confirm it
// still works on Electron 42 without needing a live FiveM game. The koffi
// D3D11 capture and the renderer <img> display are not Electron-version
// sensitive (Windows API + plain HTML), so this covers the E42 surface.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, nativeImage } = require("electron");

const OUT = path.join(os.tmpdir(), "myrp-gameframe-test.log");
const W = (m) => {
  try {
    fs.appendFileSync(OUT, `${new Date().toISOString()} ${m}\n`);
  } catch {}
  console.log(m);
};
fs.writeFileSync(OUT, "");

app.whenReady().then(() => {
  try {
    const width = 1280;
    const height = 720;
    // Synthetic BGRA buffer (mirrors GameViewManager.generateTestFrame layout).
    const bgra = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      bgra[o] = i & 0xff; // B
      bgra[o + 1] = (i >> 8) & 0xff; // G
      bgra[o + 2] = (i >> 16) & 0xff; // R
      bgra[o + 3] = 0xff; // A
    }
    const img = nativeImage.createFromBitmap(bgra, { width, height });
    const size = img.getSize();
    W(`createFromBitmap size=${JSON.stringify(size)}`);
    const jpeg = img.toJPEG(70);
    const validMagic = jpeg.length > 3 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff;
    W(`toJPEG bytes=${jpeg.length} validJpegMagic=${validMagic}`);
    const b64 = jpeg.toString("base64");
    W(`base64 len=${b64.length}`);
    const pass = size.width === width && size.height === height && validMagic && b64.length > 0;
    W(`RESULT=${pass ? "PASS" : "FAIL"}`);
  } catch (e) {
    W(`RESULT=ERROR ${e instanceof Error ? e.message : String(e)}`);
  }
  app.quit();
});

/**
 * Resolves relative <link href> and <script src> tags by reading the referenced
 * files from disk and inlining them into the HTML. This lets the iframe srcdoc
 * render the NUI without needing file:// access.
 */
export async function buildInlinedHtml(
  htmlContent: string,
  htmlAbsolutePath: string,
): Promise<string> {
  // Get the directory of the HTML file
  const parts = htmlAbsolutePath.replace(/\\/g, "/").split("/");
  parts.pop(); // remove filename
  const htmlDir = parts.join("/");

  let output = htmlContent;

  // Inline <link rel="stylesheet" href="...">
  const linkRe = /<link\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const linkMatches = [...output.matchAll(linkRe)];
  for (const match of linkMatches) {
    const href = match[1];
    if (href.startsWith("http://") || href.startsWith("https://")) continue;
    const isStylesheet =
      match[0].includes('rel="stylesheet"') ||
      match[0].includes("rel='stylesheet'") ||
      href.endsWith(".css");
    if (!isStylesheet) continue;
    try {
      const cssPath = `${htmlDir}/${href.replace(/^\.\//, "")}`;
      const css = await window.api.readFile(cssPath);
      output = output.replace(match[0], `<style>${css}</style>`);
    } catch {
      // Leave the link tag as-is if we can't read the file
    }
  }

  // Inline <script src="...">
  const scriptRe = /<script\s+[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi;
  const scriptMatches = [...output.matchAll(scriptRe)];
  for (const match of scriptMatches) {
    const src = match[1];
    if (src.startsWith("http://") || src.startsWith("https://")) continue;
    try {
      const jsPath = `${htmlDir}/${src.replace(/^\.\//, "")}`;
      const js = await window.api.readFile(jsPath);
      output = output.replace(match[0], `<script>${js}</script>`);
    } catch {
      // Leave as-is
    }
  }

  // ---- NUI Preview overrides ----
  // FiveM NUI panels typically start hidden (class="hidden", display:none, opacity:0)
  // and are shown via window.addEventListener('message', ...) from the game client.
  // In our preview iframe there's no game client, so we force everything visible
  // and dispatch fake NUI messages after the page's own scripts have loaded.

  // CSS goes in <head> — forces hidden elements visible immediately
  const previewCss = `
<style id="fivem-studio-preview">
  .hidden, [style*="display: none"], [style*="display:none"] {
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
  }
  /* Clean neutral background — focuses on generated content */
  body {
    margin: 0 !important;
    background: #f8f8f8 !important;
    min-height: 100vh !important;
  }
</style>`;

  // Script goes at end of <body> — runs AFTER the page's own app.js has registered listeners
  const previewScript = `
<script>
(function() {
  // Force-remove hidden class from common HUD containers
  var roots = document.querySelectorAll('.hidden, #hud, #ui, #app, #container, #wrapper, #main');
  roots.forEach(function(el) {
    el.classList.remove('hidden');
    el.style.display = '';
    el.style.visibility = 'visible';
    el.style.opacity = '1';
  });
  // Dispatch fake NUI messages after a tick so the page's own message listeners are ready
  setTimeout(function() {
    var msgs = [
      { action: 'show' },
      { type: 'show' },
      { type: 'ui', show: true },
      { type: 'open' },
      { showui: true },
      { action: 'update', health: 100, armor: 50, hunger: 80, thirst: 70, stress: 10, stamina: 90, oxygen: 100 },
      { type: 'update', health: 100, armor: 50, hunger: 80, thirst: 70, stress: 10, stamina: 90, oxygen: 100 },
    ];
    msgs.forEach(function(msg) { window.postMessage(msg, '*'); });
  }, 50);
})();
</script>`;

  // Inject CSS into <head>, script + minimap before </body>
  if (output.includes("</head>")) {
    output = output.replace("</head>", `${previewCss}\n</head>`);
  }
  if (output.includes("</body>")) {
    output = output.replace("</body>", `${previewScript}\n</body>`);
  } else if (output.includes("</html>")) {
    output = output.replace("</html>", `${previewScript}\n</html>`);
  } else if (!output.includes("<html")) {
    // No proper HTML structure — wrap it
    output = `<!DOCTYPE html><html><head><meta charset="utf-8">${previewCss}</head><body>${output}${previewScript}</body></html>`;
  }

  return output;
}

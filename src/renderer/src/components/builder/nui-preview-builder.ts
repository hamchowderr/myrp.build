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
  // FiveM NUIs are transparent overlays that hold MANY screens in one document
  // (a HUD, menus, a modal, a notification…), shown ONE at a time by the game via
  // window.postMessage. The old preview force-un-hid EVERYTHING, so every screen +
  // every modal rendered stacked ("something in the background"). Instead we now:
  //   • keep the NUI's own initial state (its default screen shows, the rest stay
  //     hidden) and nudge it to show via realistic messages — but NEVER fire modal/
  //     open triggers, and hard-hide overlays so a stray one can't bleed through;
  //   • keep the body transparent so the preview's backdrop shows behind it.
  // Picking a specific hidden screen/modal is the switcher's job (next step).
  const previewCss = `
<style id="myrp-build-preview">
  /* Transparent overlay + no default margins — the preview backdrop sits behind. */
  html, body { margin: 0 !important; padding: 0 !important; background: transparent !important; }
  body { min-height: 100vh; }
  /* Kill the bleed-through: modals / dialogs / overlays / toasts / notifications
     are triggered in-game, not part of the base screen — keep them hidden here. */
  [class*="modal" i], [class*="dialog" i], [class*="overlay" i],
  [class*="popup" i], [class*="toast" i], [class*="notification" i],
  [role="dialog"], [role="alertdialog"] { display: none !important; }
</style>`;

  // Script goes at end of <body> — runs AFTER the page's own listeners are set up.
  const previewScript = `
<script>
(function() {
  // Nudge the NUI to reveal its base screen the way the game would — its OWN
  // handlers decide what renders (realistic). Deliberately NO 'open' / modal
  // triggers (those caused the overlap).
  setTimeout(function() {
    var msgs = [
      { action: 'show' }, { type: 'show' }, { type: 'ui', show: true }, { showui: true },
      { action: 'update', health: 100, armor: 50, hunger: 80, thirst: 70, stress: 10, stamina: 90, oxygen: 100 },
      { type: 'update', health: 100, armor: 50, hunger: 80, thirst: 70, stress: 10, stamina: 90, oxygen: 100 },
    ];
    msgs.forEach(function(msg) { window.postMessage(msg, '*'); });
  }, 40);
  // Fallback: if the whole UI still waits on a game message we didn't match and
  // nothing rendered, reveal the first top-level screen so the pane isn't blank.
  setTimeout(function() {
    var roots = document.querySelectorAll('body > *:not(script):not(style), #app > *, #root > *, #ui > *');
    var anyVisible = Array.prototype.some.call(roots, function(el) {
      var r = el.getBoundingClientRect();
      return r.height > 24 && r.width > 24;
    });
    if (!anyVisible) {
      var first = document.querySelector('#app > *, #root > *, #ui > *, body > div');
      if (first) {
        first.classList.remove('hidden');
        first.style.display = '';
        first.style.visibility = 'visible';
        first.style.opacity = '1';
      }
    }
  }, 160);

  // Report the rendered content's bounding box so the host can scale the ACTUAL
  // UI to fit the pane — not the whole 1920x1080 transparent stage (step 2).
  function reportBounds() {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
    var els = document.body.getElementsByTagName('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > 3840 || r.height > 2160) continue;
      var bg = cs.backgroundColor;
      var hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
      var hasBorder = parseFloat(cs.borderTopWidth || '0') > 0 || parseFloat(cs.borderLeftWidth || '0') > 0;
      var hasImg = cs.backgroundImage !== 'none' || el.tagName === 'IMG' || el.tagName === 'CANVAS' || el.tagName === 'SVG';
      var hasText = false;
      for (var n = 0; n < el.childNodes.length; n++) {
        var cn = el.childNodes[n];
        if (cn.nodeType === 3 && cn.textContent && cn.textContent.trim()) { hasText = true; break; }
      }
      if (!(hasBg || hasBorder || hasImg || hasText)) continue;
      if (r.left < minX) minX = r.left;
      if (r.top < minY) minY = r.top;
      if (r.right > maxX) maxX = r.right;
      if (r.bottom > maxY) maxY = r.bottom;
      found = true;
    }
    if (!found) return;
    try {
      window.parent.postMessage(
        { source: 'nui-preview', type: 'bounds', rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } },
        '*',
      );
    } catch (e) { /* preview-only */ }
  }
  setTimeout(reportBounds, 240);
  setTimeout(reportBounds, 720);

  // ---- Screen switcher support (step 4) ----
  // A NUI holds many screens in one document (tab panels, menus, modals) shown one
  // at a time. Enumerate the top-level ones so the host can offer a switcher, and
  // force-show a chosen one on request (bypassing the NUI's own game-gated nav).
  var SCREEN_SEL = '.tab-panel, [class*=screen i], [class*=view i], [class*=page i], [class*=modal i], [class*=dialog i], [role=dialog], [role=alertdialog]';
  function screenLabel(el, i) {
    var h = el.querySelector('h1,h2,h3,[class*=title i]');
    var txt = h && (h.textContent || '').trim();
    if (txt) return txt.slice(0, 40);
    if (el.id) return el.id.replace(/[-_]/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
    return 'Screen ' + (i + 1);
  }
  function topLevelScreens() {
    var all = Array.prototype.slice.call(document.querySelectorAll(SCREEN_SEL));
    return all.filter(function (el) {
      // top-level only: not nested inside another candidate
      return !all.some(function (o) { return o !== el && o.contains(el); });
    });
  }
  function enumerateScreens() {
    var list = topLevelScreens();
    var screens = list.map(function (el, i) {
      var id = el.id || ('__nui_screen_' + i);
      if (!el.id) el.setAttribute('data-nui-screen', id);
      var isOverlay = /modal|dialog|overlay|popup/i.test((el.className || '') + ' ' + (el.getAttribute('role') || ''));
      return { id: id, label: screenLabel(el, i), overlay: isOverlay };
    });
    try {
      window.parent.postMessage({ source: 'nui-preview', type: 'screens', screens: screens }, '*');
    } catch (e) { /* preview-only */ }
  }
  setTimeout(enumerateScreens, 300);
  setTimeout(enumerateScreens, 780);

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'nui-preview-host' || d.type !== 'showScreen') return;
    var target = document.getElementById(d.id) || document.querySelector('[data-nui-screen="' + d.id + '"]');
    if (!target) return;
    topLevelScreens().forEach(function (el) {
      if (el === target || el.contains(target) || target.contains(el)) return;
      el.classList.remove('active', 'show', 'open', 'visible', 'shown');
      el.classList.add('hidden');
      el.style.setProperty('display', 'none', 'important');
    });
    // Force the chosen screen visible even against our overlay-hide stylesheet
    // (inline !important beats the injected stylesheet's !important).
    target.classList.remove('hidden');
    target.classList.add('active', 'show', 'visible');
    target.style.removeProperty('display');
    if (getComputedStyle(target).display === 'none') {
      target.style.setProperty('display', 'block', 'important');
    }
    setTimeout(reportBounds, 60);
  });
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

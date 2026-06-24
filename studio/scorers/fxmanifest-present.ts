import { createScorer } from "@mastra/core/evals";
import { extractWrittenFiles, flattenGenerated } from "./shared";

// Did the generation produce a sane fxmanifest.lua? A loadable ox resource needs
// a manifest with fx_version + at least one script entry. We check the written
// files first (a real fxmanifest.lua), then fall back to scanning all generated
// content for the manifest signature. Score: 1 if both present, else 0.
export const fxmanifestPresentScorer = createScorer({
  id: "fxmanifest-present",
  name: "fxmanifest present",
  description:
    "Checks the generation produced a valid-looking fxmanifest.lua (fx_version + a script entry).",
  type: "agent",
})
  .analyze(({ run }) => {
    const files = extractWrittenFiles(run.output);
    const manifest = files.find((f) => /(^|\/)fxmanifest\.lua$/i.test(f.path));
    const haystack = manifest?.content ?? flattenGenerated(run.output);
    const hasFxVersion = /\bfx_version\s+['"]/.test(haystack);
    const hasScript =
      /\b(client_script|server_script|shared_script|client_scripts|server_scripts|shared_scripts)\b/.test(
        haystack,
      );
    return { wroteManifestFile: !!manifest, hasFxVersion, hasScript };
  })
  .generateScore(({ results }) => {
    const a = results.analyzeStepResult;
    return a.hasFxVersion && a.hasScript ? 1 : 0;
  })
  .generateReason(({ results }) => {
    const a = results.analyzeStepResult;
    if (a.hasFxVersion && a.hasScript) {
      return a.wroteManifestFile
        ? "Wrote an fxmanifest.lua with fx_version and a script entry."
        : "Generated an fxmanifest with fx_version and a script entry.";
    }
    const missing = [!a.hasFxVersion && "fx_version", !a.hasScript && "a *_script entry"]
      .filter(Boolean)
      .join(" and ");
    return `No valid fxmanifest detected — missing ${missing}.`;
  });

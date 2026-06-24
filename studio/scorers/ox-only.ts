import { createScorer } from "@mastra/core/evals";
import { flattenGenerated } from "./shared";

// ox_overextended ONLY. Flags non-ox framework / DB patterns in the generated
// code. A hit -> 0; clean -> 1. Intentionally conservative on the patterns so a
// stray mention in a comment doesn't false-positive too easily.
const FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: "ESX", re: /\bESX\b|es_extended|\besx_/ },
  {
    label: "QBCore/qbx",
    re: /QBCore|qb-core|qbx_core|qbx-core|\bqbx\b|exports\[['"]qb-core['"]\]/,
  },
  { label: "mysql-async/ghmattimysql", re: /mysql-async|MySQL\.Async|ghmattimysql/ },
];

export const oxOnlyScorer = createScorer({
  id: "ox-only",
  name: "ox-only",
  description:
    "Flags non-ox framework or DB patterns (ESX, QBCore, mysql-async) in the generated code.",
  type: "agent",
})
  .analyze(({ run }) => {
    const code = flattenGenerated(run.output);
    const hits = FORBIDDEN.filter((f) => f.re.test(code)).map((f) => f.label);
    return { hits };
  })
  .generateScore(({ results }) => (results.analyzeStepResult.hits.length === 0 ? 1 : 0))
  .generateReason(({ results }) => {
    const { hits } = results.analyzeStepResult;
    return hits.length === 0
      ? "Clean — only ox_overextended patterns detected."
      : `Non-ox patterns detected: ${hits.join(", ")}. myRP.build is ox-only.`;
  });

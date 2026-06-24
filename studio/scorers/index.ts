import type { MastraScorers } from "@mastra/core/evals";
import { fxmanifestPresentScorer } from "./fxmanifest-present";
import { luacheckPassScorer } from "./luacheck-pass";
import { oxOnlyScorer } from "./ox-only";

// Studio-only quality scorers. Net-new + dataset-free: nothing here comes from
// the private eval repo; they give self-hosters a quick "is this generation any
// good?" signal in Studio.
//
// Two registrations are needed:
//  - the AGENT's `scorers` map (with sampling) makes them RUN live on each
//    generation, so scores show on the agent's Evaluate tab; and
//  - the Mastra instance's `scorers` registry (raw scorers) makes them LISTED
//    in Studio's Scorers page (mastra.listScorers()).
export const studioScorers: MastraScorers = {
  "fxmanifest-present": { scorer: fxmanifestPresentScorer, sampling: { type: "ratio", rate: 1 } },
  "luacheck-pass": { scorer: luacheckPassScorer, sampling: { type: "ratio", rate: 1 } },
  "ox-only": { scorer: oxOnlyScorer, sampling: { type: "ratio", rate: 1 } },
};

export const studioScorerRegistry = {
  "fxmanifest-present": fxmanifestPresentScorer,
  "luacheck-pass": luacheckPassScorer,
  "ox-only": oxOnlyScorer,
};

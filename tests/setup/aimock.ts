import { resolve } from "node:path";
import { useAimock } from "@copilotkit/aimock/vitest";
import { beforeAll } from "vitest";

/**
 * Wire AIMock for a Mastra agent test file. Call once at the top level of a
 * test file. Starts a deterministic mock LLM server, loads fixtures from
 * tests/fixtures/llmock, and points the agent's OpenAI-compatible provider at it.
 *
 * AIMock is OpenAI-compatible first (see vault: AIMock note), so the agent's
 * model resolution uses its OPENAI_BASE_URL branch — createOpenAI().chat() hits
 * /v1/chat/completions, AIMock's native protocol. Notes:
 *  - `useAimock`'s patchEnv sets OPENAI_BASE_URL itself, but we set it here too
 *    (with the required `/v1` suffix) once the server URL is known, in a
 *    beforeAll registered AFTER useAimock's own — explicit + deterministic.
 *  - Use `||`, not `??`, so an empty-string env var doesn't slip through as a key.
 *  - The model id is arbitrary — fixtures match on userMessage/tools, not model;
 *    gpt-4o is the canonical AIMock model.
 *
 * Returns the aimock handle getter so tests can journal/assert on requests.
 */
export function setupAimock() {
  const getAimock = useAimock({
    fixtures: resolve(process.cwd(), "tests/fixtures/llmock"),
    logLevel: "silent",
  });

  beforeAll(() => {
    const { url } = getAimock();
    // AIMock is OpenAI-compatible first — point the agent's OpenAI provider at it
    // via OPENAI_BASE_URL (its createOpenAI().chat() branch → /v1/chat/completions).
    // The gateway / bare-provider paths are not exercised in tests.
    process.env.OPENAI_BASE_URL = `${url}/v1`;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "mock";
    process.env.MASTRA_MODEL = process.env.MASTRA_MODEL || "gpt-4o";
  });

  return getAimock;
}

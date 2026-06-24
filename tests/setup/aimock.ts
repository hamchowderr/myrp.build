import { resolve } from "node:path";
import { useAimock } from "@copilotkit/aimock/vitest";
import { beforeAll } from "vitest";

/**
 * Wire AIMock for a Mastra agent test file. Call once at the top level of a
 * test file. Starts a deterministic mock LLM server, loads fixtures from
 * tests/fixtures/llmock, and points Mastra's anthropic provider at it.
 *
 * Gotchas baked in (see vault: 2. Areas/development/testing/aimock.md):
 *  - `useAimock`'s patchEnv only sets OPENAI_BASE_URL, so we set
 *    ANTHROPIC_BASE_URL ourselves (with the required `/v1` suffix) once the
 *    server URL is known — in a beforeAll registered AFTER useAimock's own.
 *  - `.env` ships ANTHROPIC_API_KEY='' (empty string). Use `||`, not `??`, so
 *    Mastra doesn't see '' and throw "Could not find API key".
 *  - The model MUST be anthropic/* — google/ hardcodes its base URL and
 *    openai/ hits the Responses API; neither is interceptable by AIMock.
 *    Haiku is the canonical AIMock model.
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
    process.env.ANTHROPIC_BASE_URL = `${url}/v1`;
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "mock";
    process.env.MASTRA_MODEL = process.env.MASTRA_MODEL || "anthropic/claude-haiku-4-5";
  });

  return getAimock;
}

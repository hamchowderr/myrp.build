// Fail-fast env access for edge functions. A required secret that is missing
// should crash the function at boot with a clear message — never fall back to a
// hardcoded default (a wrong default silently sends users/payments to dead URLs).
export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

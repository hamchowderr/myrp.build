/**
 * Branded chat empty-state: Rockstar-style star logo, headline, and a 2×2 grid
 * of clickable starter prompts that send on click. Shared by AEChat (legacy) and
 * HarnessChat (alpha) so both paths get the same first-impression UI.
 */

// Starter examples shown in the empty state (the card grid).
const SUGGESTIONS = [
  "A car dealership with test drive support",
  "HUD with health, armor, and minimap toggle",
  "Drug crafting system with ox_inventory items",
  "Police MDT with warrant lookup and BOLO system",
];

/** Rockstar-style star logo for the empty state. */
function StudioLogo() {
  return (
    <div className="animate-fade-slide-in mb-6" style={{ animationDelay: "0ms" }}>
      <svg
        width="56"
        height="56"
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="drop-shadow-lg"
        aria-hidden="true"
      >
        <path
          d="M32 4L38.9 22.5H58.4L42.7 34.5L49.6 53L32 41L14.4 53L21.3 34.5L5.6 22.5H25.1L32 4Z"
          className="fill-foreground/90"
        />
        <path
          d="M32 14L36.4 25.5H48.6L38.9 33L43.4 44.5L32 37L20.6 44.5L25.1 33L15.4 25.5H27.6L32 14Z"
          className="fill-background"
        />
      </svg>
    </div>
  );
}

export function ChatEmptyState({
  onSend,
  description = "Describe a FiveM resource and it will be generated to disk",
}: {
  onSend: (text: string) => void;
  description?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
      <StudioLogo />
      <p className="animate-fade-slide-in mb-1 text-lg font-bold tracking-tight text-text-primary">
        What do you want to build?
      </p>
      <p
        className="animate-fade-slide-in mb-8 text-sm text-text-muted"
        style={{ animationDelay: "60ms" }}
      >
        {description}
      </p>
      <div className="grid w-full max-w-lg grid-cols-2 gap-2">
        {SUGGESTIONS.map((prompt, i) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onSend(prompt)}
            style={{ animationDelay: `${120 + i * 50}ms` }}
            className="animate-fade-slide-in rounded-lg border border-border-subtle px-4 py-3 text-left text-xs text-text-muted transition-all hover:-translate-y-0.5 hover:border-text-dim hover:bg-hover hover:text-text-primary hover:shadow-lg"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

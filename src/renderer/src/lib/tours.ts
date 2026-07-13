import type { Tour } from "@renderer/components/ui/tour";

const TOUR_SEEN_KEY = "myrp-build-tour-seen";

export function hasSeenTour(tourId: string): boolean {
  try {
    const seen = JSON.parse(localStorage.getItem(TOUR_SEEN_KEY) ?? "[]");
    return Array.isArray(seen) && seen.includes(tourId);
  } catch {
    return false;
  }
}

export function markTourSeen(tourId: string): void {
  try {
    const seen = JSON.parse(localStorage.getItem(TOUR_SEEN_KEY) ?? "[]");
    if (Array.isArray(seen) && !seen.includes(tourId)) {
      seen.push(tourId);
      localStorage.setItem(TOUR_SEEN_KEY, JSON.stringify(seen));
    }
  } catch {
    localStorage.setItem(TOUR_SEEN_KEY, JSON.stringify([tourId]));
  }
}

export const TOURS: Tour[] = [
  {
    id: "welcome",
    steps: [
      {
        id: "chat-input",
        title: "Describe what you want to build",
        content:
          "Type a plain-English description of a FiveM resource — a car dealership, a police MDT, a HUD — and the AI agent will generate it directly to your server's resources folder.",
        side: "top",
        sideOffset: 12,
      },
      {
        id: "artifact-panel",
        title: "Your generated files appear here",
        content:
          "After generation, browse every file the agent wrote. Click any file to view its source code, edit it inline, or preview NUI (HTML) resources.",
        side: "left",
        sideOffset: 12,
      },
      {
        id: "terminal-tab",
        title: "Server console",
        content:
          "See your FXServer's live console output here — startup logs, errors, and resource messages. Useful for debugging after you restart a resource.",
        side: "left",
        sideOffset: 12,
      },
      {
        id: "server-status",
        title: "FXServer controls",
        content:
          "Start, stop, and monitor your local FXServer right from here. When it shows 'online', open FiveM, press F8, and type 'connect localhost:30120' to walk around your server and test resources in-game.",
        side: "top",
        sideOffset: 8,
      },
      {
        id: "status-bar",
        title: "Status bar",
        content:
          "Shows your detected framework (ESX, QBCore, ox_core), generation progress, server status, and subscription info. The layout toggle on the left switches between classic and chat-first views.",
        side: "top",
        sideOffset: 8,
      },
    ],
  },
];

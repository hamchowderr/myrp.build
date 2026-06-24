/**
 * Voice input → text (fivem-studio-adb). The Web Speech API can't work in
 * Electron (Chromium has no key for Google's private speech backend → error:
 * network), so we do STT ourselves: the renderer records mic audio
 * (MediaRecorder) and sends it here to transcribe via OpenAI, returning the text
 * to drop into the prompt. Owner/dev uses OPENAI_API_KEY (injected by dev:secrets,
 * same key RAG embeddings use). Paid-user STT billing is a later concern.
 */
import { ipcMain } from "electron";
import log from "electron-log/main";

const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe";

export interface TranscriptResult {
  text?: string;
  error?: string;
}

export function registerVoiceHandlers(): void {
  ipcMain.handle(
    "voice:transcribe",
    async (_event, audioBase64: string, mimeType: string): Promise<TranscriptResult> => {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return { error: "Voice input needs OPENAI_API_KEY (run with dev:secrets)." };
      if (!audioBase64) return { error: "No audio captured." };
      try {
        const buf = Buffer.from(audioBase64, "base64");
        const form = new FormData();
        form.append("file", new Blob([buf], { type: mimeType || "audio/webm" }), "audio.webm");
        form.append("model", MODEL);
        const res = await fetch(TRANSCRIBE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 200);
          log.warn(`[voice] transcribe ${res.status}: ${detail}`);
          return { error: `Transcription failed (${res.status}).` };
        }
        const data = (await res.json()) as { text?: string };
        return { text: (data.text ?? "").trim() };
      } catch (err) {
        log.error("[voice] transcribe error:", err);
        return { error: err instanceof Error ? err.message : "Transcription error." };
      }
    },
  );
}

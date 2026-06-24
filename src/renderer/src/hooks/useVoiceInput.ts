/**
 * Voice input (fivem-studio-adb): record mic audio (MediaRecorder), send to the
 * main process for OpenAI transcription, hand the text back to the caller to drop
 * into the prompt. Replaces the dead Web Speech mic (can't work in Electron).
 */
import { useCallback, useRef, useState } from "react";

export interface VoiceInput {
  recording: boolean;
  transcribing: boolean;
  error: string | null;
  /** Start recording if idle, stop + transcribe if recording. */
  toggle: () => void;
}

/** Base64-encode an ArrayBuffer in chunks (avoids call-stack blowups on large audio). */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function useVoiceInput(onText: (text: string) => void): VoiceInput {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        for (const t of stream.getTracks()) t.stop();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const b64 = toBase64(await blob.arrayBuffer());
          const res = await window.api.transcribeAudio(b64, blob.type);
          if (res.error) setError(res.error);
          else if (res.text) onText(res.text);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Transcription failed.");
        } finally {
          setTranscribing(false);
        }
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone access failed.");
    }
  }, [onText]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    recRef.current = null;
    setRecording(false);
  }, []);

  const toggle = useCallback(() => {
    if (recording) stop();
    else void start();
  }, [recording, start, stop]);

  return { recording, transcribing, error, toggle };
}

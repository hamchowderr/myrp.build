/**
 * Custom AI SDK v6 ChatTransport that bridges useChat to the Electron main
 * process over IPC (fivem-studio-k8v). Non-HTTP transports are a first-class
 * AI SDK extension point — see ChatTransport docs.
 *
 * sendMessages() returns a ReadableStream<UIMessageChunk> whose chunks are
 * pushed from main via window.api.chat.onChunk (main runs agent.stream() ->
 * @mastra/ai-sdk toAISdkStream(v6) -> webContents.send("chat:chunk")). Only the
 * newest user message is sent; the Mastra memory thread (= chatId) carries
 * prior turns server-side.
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

/** Concatenate the text parts of a UIMessage into a plain prompt string. */
function messageText(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export class IpcChatTransport implements ChatTransport<UIMessage> {
  // Required by ChatTransport interface contract from the `ai` package.
  // fallow-ignore-next-line unused-class-member
  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const { messages, chatId, abortSignal } = options;
    const text = messageText(messages.at(-1));
    // Model + access token + active workspace ride in the per-call body (useAEChat
    // passes them). workspaceId scopes cloud chat memory to the active tenant (M2.4).
    const body = options.body as
      | { model?: string; accessToken?: string; workspaceId?: string }
      | undefined;
    const model = body?.model;
    const accessToken = body?.accessToken;
    const workspaceId = body?.workspaceId;

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        let closed = false;
        const cleanup = (): void => {
          offChunk();
          offDone();
          offError();
        };
        const offChunk = window.api.chat.onChunk((chunk) => {
          if (!closed) controller.enqueue(chunk as UIMessageChunk);
        });
        const offDone = window.api.chat.onDone(() => {
          if (closed) return;
          closed = true;
          cleanup();
          controller.close();
        });
        const offError = window.api.chat.onError((message) => {
          if (closed) return;
          closed = true;
          cleanup();
          controller.error(new Error(message));
        });

        abortSignal?.addEventListener("abort", () => {
          void window.api.chat.cancel();
        });

        void window.api.chat.start({ text, chatId, model, accessToken, workspaceId });
      },
    });
  }

  // Non-persistent protocol — nothing to reconnect to.
  // Required by ChatTransport interface contract from the `ai` package.
  // fallow-ignore-next-line unused-class-member
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}

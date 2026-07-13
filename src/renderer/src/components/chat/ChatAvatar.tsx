/**
 * Round avatar next to each chat message. Shared by AEChat (legacy) and
 * HarnessChat (alpha) so both paths render the same identity affordance.
 * AI Elements ships only an `src`-based MessageAvatar; we need an account-aware
 * one — the user's Discord photo when signed in, the generic User icon in
 * dev-bypass / no photo, and a Bot icon for the assistant (matches the thinking
 * indicator so it persists when the real message streams in).
 */
import { Avatar, AvatarFallback, AvatarImage } from "@renderer/components/ui/avatar";
import { useAccount } from "@renderer/lib/account";
import type { UIMessage } from "ai";
import { Bot, User } from "lucide-react";

export function ChatAvatar({ role }: { role: UIMessage["role"] }) {
  const isUser = role === "user";
  const { avatarUrl, displayName } = useAccount();
  if (isUser && avatarUrl) {
    return (
      <Avatar className="size-7 shrink-0">
        <AvatarImage src={avatarUrl} alt={displayName || "You"} />
        <AvatarFallback className="bg-secondary text-text-muted">
          <User className="size-4" />
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-text-muted">
      {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
    </div>
  );
}

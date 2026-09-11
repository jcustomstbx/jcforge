export interface TwitchChatEvent {
  emoteCount: number;
}

/**
 * Anonymous, read-only connection to Twitch IRC over WebSocket. No auth
 * token needed - just a channel name - per Twitch's anonymous-read IRC
 * support.
 */
export class TwitchChatConnection {
  private ws: WebSocket | null = null;
  private channel: string;
  onMessage: ((e: TwitchChatEvent) => void) | null = null;
  onStatusChange: ((connected: boolean) => void) | null = null;

  constructor(channel: string) {
    this.channel = channel.trim().toLowerCase().replace(/^#/, "");
  }

  connect(): void {
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;

    ws.onopen = () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      ws.send(`JOIN #${this.channel}`);
      this.onStatusChange?.(true);
    };

    ws.onmessage = (ev) => {
      const lines = String(ev.data)
        .split("\r\n")
        .filter((l) => l.length > 0);
      for (const line of lines) {
        if (line.startsWith("PING")) {
          ws.send("PONG :tmi.twitch.tv");
          continue;
        }
        if (line.includes("PRIVMSG")) {
          this.onMessage?.({ emoteCount: parseEmoteCount(line) });
        }
      }
    };

    ws.onclose = () => {
      this.onStatusChange?.(false);
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}

function parseEmoteCount(line: string): number {
  if (!line.startsWith("@")) return 0;
  const tagsEnd = line.indexOf(" ");
  if (tagsEnd === -1) return 0;
  const tagsPart = line.slice(1, tagsEnd);
  for (const tag of tagsPart.split(";")) {
    const eq = tag.indexOf("=");
    if (eq === -1) continue;
    if (tag.slice(0, eq) !== "emotes") continue;
    const value = tag.slice(eq + 1);
    if (!value) return 0;
    return value.split("/").filter(Boolean).length;
  }
  return 0;
}

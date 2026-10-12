import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type ContentBlock = {
  type?: string;
  text?: string;
};

const textFrom = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (block): block is ContentBlock =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as ContentBlock).type === "text" &&
        typeof (block as ContentBlock).text === "string",
    )
    .map((block) => block.text!)
    .join("\n");
};

type AssistantEntry = SessionMessageEntry & {
  message: Extract<SessionMessageEntry["message"], { role: "assistant" }>;
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("md", {
    description: "Save the last assistant message as Markdown",
    handler: async (args, ctx) => {
      const entry = [...ctx.sessionManager.getBranch()]
        .reverse()
        .find((item): item is AssistantEntry => item.type === "message" && item.message.role === "assistant");
      const text = entry ? textFrom(entry.message.content) : "";

      if (!text) {
        ctx.ui.notify("No assistant message to save", "warning");
        return;
      }

      const requestedPath = args.trim() || "last_message";
      const path = resolve(ctx.cwd, requestedPath.endsWith(".md") ? requestedPath : `${requestedPath}.md`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
      ctx.ui.notify(`Saved last assistant message to ${path}`, "info");
    },
  });
}

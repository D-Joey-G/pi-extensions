import {
  AssistantMessageComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  CustomMessageComponent,
  getMarkdownTheme,
  type ToolDefinition,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { RpcRecord } from "./agent.ts";

// Wire messages are plain JSON; only the fields read here are typed.
type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type Message = {
  role: string;
  content?: string | Block[];
  display?: boolean;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  isError?: boolean;
  [key: string]: unknown;
};
type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];

const BUILT_IN_RENDERERS: Record<string, (cwd: string) => ToolDefinition<any, any, any>> = {
  read: createReadToolDefinition,
  bash: createBashToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

function userText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * A worktree agent's conversation drawn with pi's own message components,
 * rebuilt from `get_messages` and kept current from the RPC event stream.
 */
export class Transcript extends Container {
  private readonly tools = new Map<string, ToolExecutionComponent>();
  private readonly definitions = new Map<string, ToolDefinition<any, any, any>>();
  private streaming: { component: AssistantMessageComponent; message: Message } | undefined;
  private expanded = false;

  constructor(
    private readonly tui: TUI,
    private readonly cwd: string,
  ) {
    super();
  }

  load(messages: Message[]): void {
    this.clear();
    this.tools.clear();
    this.streaming = undefined;
    for (const message of messages) {
      if (message.role === "toolResult")
        this.finishTool(message.toolCallId, { ...message, isError: !!message.isError } as ToolResult);
      else this.add(message);
    }
    // Calls still without a result stay in `tools`: one may be running and report its result next.
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    for (const child of this.children) (child as { setExpanded?: (value: boolean) => void }).setExpanded?.(expanded);
  }

  get toolsExpanded(): boolean {
    return this.expanded;
  }

  handle(record: RpcRecord): void {
    switch (record.type) {
      case "message_start": {
        const message = record.message as Message;
        if (message.role === "assistant") {
          const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
          this.streaming = { component, message: structuredClone(message) };
          this.addChild(component);
          component.updateContent(this.streaming.message as never, true);
        } else if (message.role !== "toolResult") {
          this.add(message);
        }
        break;
      }
      case "message_update":
        if (this.streaming) this.applyDelta(record.assistantMessageEvent as Record<string, unknown>);
        break;
      case "message_end": {
        const message = record.message as Message;
        if (message.role !== "assistant") break;
        // A message that started before the transcript was loaded arrives here whole.
        if (!this.streaming) {
          this.add(message);
          break;
        }
        this.streaming.message = message;
        this.streaming.component.updateContent(message as never, false);
        this.syncToolCalls(message);
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
          for (const component of this.tools.values())
            component.updateResult({ content: [{ type: "text", text }], isError: true });
          this.tools.clear();
        } else {
          for (const component of this.tools.values()) component.setArgsComplete();
        }
        this.streaming = undefined;
        break;
      }
      case "tool_execution_start": {
        if (record.parentToolCallId) break;
        const id = String(record.toolCallId);
        const component = this.tools.get(id) ?? this.addTool(String(record.toolName), id, record.args);
        component.markExecutionStarted();
        break;
      }
      case "tool_execution_update":
        this.tools
          .get(String(record.toolCallId))
          ?.updateResult({ ...(record.partialResult as ToolResult), isError: false }, true);
        break;
      case "tool_execution_end":
        this.finishTool(String(record.toolCallId), {
          ...(record.result as ToolResult),
          isError: !!record.isError,
          durationMs: record.durationMs as number | undefined,
        });
        break;
    }
  }

  private add(message: Message): void {
    switch (message.role) {
      case "user": {
        const text = userText(message);
        if (!text) return;
        if (this.children.length) this.addChild(new Spacer(1));
        this.addChild(new UserMessageComponent(text, getMarkdownTheme()));
        return;
      }
      case "assistant":
        this.addChild(new AssistantMessageComponent(message as never, false, getMarkdownTheme()));
        this.syncToolCalls(message);
        return;
      case "custom":
        if (message.display)
          this.addExpandable(new CustomMessageComponent(message as never, undefined, getMarkdownTheme()));
        return;
      case "compactionSummary":
        this.addChild(new Spacer(1));
        this.addExpandable(new CompactionSummaryMessageComponent(message as never, getMarkdownTheme()));
        return;
      case "branchSummary":
        this.addChild(new Spacer(1));
        this.addExpandable(new BranchSummaryMessageComponent(message as never, getMarkdownTheme()));
        return;
    }
  }

  private addExpandable(component: Component & { setExpanded(expanded: boolean): void }): void {
    component.setExpanded(this.expanded);
    this.addChild(component);
  }

  /** Every tool call gets its own row, created when the call first appears. */
  private syncToolCalls(message: Message): void {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type !== "toolCall" || !block.id) continue;
      const existing = this.tools.get(block.id);
      if (existing) existing.updateArgs(block.arguments ?? {});
      else this.addTool(block.name ?? "tool", block.id, block.arguments ?? {});
    }
  }

  private addTool(name: string, id: string, args: unknown): ToolExecutionComponent {
    const component = new ToolExecutionComponent(name, id, args, undefined, this.definition(name), this.tui, this.cwd);
    component.setExpanded(this.expanded);
    this.addChild(component);
    this.tools.set(id, component);
    return component;
  }

  private finishTool(id: string | undefined, result: ToolResult): void {
    if (!id) return;
    this.tools.get(id)?.updateResult(result);
    this.tools.delete(id);
  }

  /** Built-in tools draw as in the main chat; extension tools use the generic fallback. */
  private definition(name: string): ToolDefinition<any, any, any> | undefined {
    const create = BUILT_IN_RENDERERS[name];
    if (!create) return undefined;
    let definition = this.definitions.get(name);
    if (!definition) this.definitions.set(name, (definition = create(this.cwd)));
    return definition;
  }

  /** Wire updates carry deltas only; rebuild the partial message from them. */
  private applyDelta(event: Record<string, unknown>): void {
    const streaming = this.streaming!;
    const content = (Array.isArray(streaming.message.content) ? streaming.message.content : []) as Block[];
    streaming.message.content = content;
    const index = event.contentIndex as number;
    const delta = String(event.delta ?? "");
    switch (event.type) {
      case "text_start":
        content[index] = { type: "text", text: "" };
        break;
      case "text_delta":
        content[index] = { type: "text", text: (content[index]?.text ?? "") + delta };
        break;
      case "text_end":
        content[index] = { type: "text", text: String(event.content ?? content[index]?.text ?? "") };
        break;
      case "thinking_start":
        content[index] = { type: "thinking", thinking: "" };
        break;
      case "thinking_delta":
        content[index] = { ...content[index], type: "thinking", thinking: (content[index]?.thinking ?? "") + delta };
        break;
      case "thinking_end":
        content[index] = {
          ...content[index],
          type: "thinking",
          thinking: String(event.content ?? content[index]?.thinking ?? ""),
        };
        break;
      case "toolcall_start":
        content[index] = { type: "toolCall", id: String(event.id), name: String(event.toolName), arguments: {} };
        break;
      case "toolcall_end":
        content[index] = event.toolCall as Block;
        break;
      default:
        return;
    }
    streaming.component.updateContent(streaming.message as never, true);
    this.syncToolCalls(streaming.message);
  }
}

import type { ProviderTool } from "../../provider/types.ts";
import { atMost, type AgentTool, type ToolRisk } from "../types.ts";

/**
 * Which tools exist for this turn.
 *
 * The registry is where a mode becomes a restriction. ARCHITECT does not have a
 * writing tool withheld at approval time — it never receives one, so the model
 * has nothing to ask for. A restriction the model can see and not use is a
 * restriction it will eventually argue with; one it cannot see is not.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | null {
    return this.tools.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** A registry holding only the tools a mode's ceiling permits. */
  withCeiling(ceiling: ToolRisk): ToolRegistry {
    return new ToolRegistry(this.list().filter((tool) => atMost(tool.risk, ceiling)));
  }

  /**
   * The provider-facing form.
   *
   * `risk`, `summarize` and `preview` stay behind: they exist for the user and
   * the policy, and a model told which of its tools are considered dangerous
   * has been handed a map of what to argue about.
   */
  toProviderTools(): ProviderTool[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}

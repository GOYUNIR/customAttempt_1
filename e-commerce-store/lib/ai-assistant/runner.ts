/**
 * AI ASSISTANT — runner. Ties the guardrails (lib/ai-assistant/guardrails.ts),
 * the tool implementations (lib/ai-assistant/tools.ts), and the existing
 * multi-provider AI driver (services/ai/factory.ts) together.
 *
 * Reuses `AiFactory.getDriver().complete(prompt)` — the SAME universal
 * text-completion primitive every other AI feature in this codebase already
 * goes through (animation generation, SVG prompts) — rather than adding a
 * new SDK dependency (Vercel AI SDK / a Workers AI binding) that would only
 * work with a subset of the providers this store can already be configured
 * with (DeepSeek, OpenAI, Anthropic, Gemini, Replicate, Workers AI). Tool
 * selection is a single-turn "respond with one JSON object naming the tool
 * and its arguments" protocol, which works identically across every driver.
 */

import { AiFactory } from '@/services/ai/factory';
import { toolsVisibleToActor, canExecuteTool, parseToolCall, type AssistantActor } from '@/lib/ai-assistant/guardrails';
import { ASSISTANT_TOOLS, type ToolContext } from '@/lib/ai-assistant/tools';

export interface AssistantRunResult {
  ok: boolean;
  reply: string;
  toolCalled: string | null;
  toolResult: unknown;
  error?: string;
}

function buildSystemPrompt(tools: typeof ASSISTANT_TOOLS): string {
  const toolDocs = tools
    .map((t) => {
      const params = Object.entries(t.parameters)
        .map(([name, spec]) => `${name} (${spec.type}${spec.required ? ', required' : ''}): ${spec.description}`)
        .join('; ');
      return `- ${t.name}: ${t.description}${params ? ` Parameters: ${params}` : ' No parameters.'}`;
    })
    .join('\n');
  return [
    'You are a store-management assistant with access to a FIXED set of tools for THIS store only.',
    'Available tools:',
    toolDocs || '(none available to this user)',
    '',
    'If the user\'s request matches one of these tools, respond with EXACTLY one JSON object and nothing else:',
    '{"tool": "<tool_name>", "args": { ... }}',
    'If no tool matches, or you need clarification, respond with EXACTLY one JSON object:',
    '{"tool": null, "reply": "<your message to the user>"}',
    'Never invent a tool name that is not in the list above. Never ask the user for a different tenant/store id — you only ever act on the current store.',
  ].join('\n');
}

/**
 * Run one assistant turn. `actor`/`tenantId` come ONLY from the caller's own
 * resolved admin session (see app/api/admin/ai-assistant/route.ts) — never
 * from the user's message or the model's output, which is what makes a
 * cross-tenant instruction inside `userMessage` structurally inert: there is
 * no field anywhere in this pipeline the model's text can populate that
 * changes which tenant a tool acts on.
 */
export async function runAssistantTurn(userMessage: string, actor: AssistantActor, tenantId: string, actorEmail: string): Promise<AssistantRunResult> {
  const visibleTools = toolsVisibleToActor(ASSISTANT_TOOLS, actor);
  const driver = await AiFactory.getDriver();
  if (!driver) {
    return { ok: false, reply: '', toolCalled: null, toolResult: null, error: 'No AI provider is configured for this store.' };
  }

  const prompt = `${buildSystemPrompt(visibleTools)}\n\nUser: ${String(userMessage || '').slice(0, 4000)}`;
  const completion = await driver.complete(prompt);
  if (!completion.ok) {
    return { ok: false, reply: '', toolCalled: null, toolResult: null, error: 'The AI provider request failed.' };
  }

  const parsed = parseToolCall(completion.text);
  if (!parsed || !parsed.tool) {
    // No tool call — treat the raw completion as a plain reply.
    return { ok: true, reply: completion.text.slice(0, 4000), toolCalled: null, toolResult: null };
  }

  const tool = visibleTools.find((t) => t.name === parsed.tool);
  if (!tool) {
    // The model named a tool that either doesn't exist or wasn't in the
    // visible set for this actor — refuse rather than guess. This is the
    // execution-gate re-check lib/ai-assistant/guardrails.ts's header
    // describes: even if a future prompt change somehow exposed a hidden
    // tool name, canExecuteTool() below would still block it.
    return {
      ok: false,
      reply: '',
      toolCalled: parsed.tool,
      toolResult: null,
      error: `Tool "${parsed.tool}" is not available to your role.`,
    };
  }
  if (!canExecuteTool(tool, actor)) {
    return { ok: false, reply: '', toolCalled: tool.name, toolResult: null, error: 'Not permitted to run this tool.' };
  }

  const ctx: ToolContext = { tenantId, actorRole: actor.role, actorEmail };
  const result = await tool.execute(parsed.args, ctx);
  if (!result.ok) {
    return { ok: false, reply: '', toolCalled: tool.name, toolResult: null, error: result.error };
  }
  return { ok: true, reply: `Ran ${tool.name}.`, toolCalled: tool.name, toolResult: result.result };
}

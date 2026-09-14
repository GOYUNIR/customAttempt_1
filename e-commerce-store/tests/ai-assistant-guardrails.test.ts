import assert from 'node:assert/strict';
import test from 'node:test';
import { canExecuteTool, toolsVisibleToActor, parseToolCall, type AssistantToolSpec, type AssistantActor } from '../lib/ai-assistant/guardrails.ts';

const SAFE_TOOL: AssistantToolSpec = {
  name: 'audit_seo',
  description: 'Read-only SEO audit',
  allowedRoles: ['super_admin', 'sales', 'owner', 'staff'],
  allowDuringImpersonation: true,
};

const SENSITIVE_TOOL: AssistantToolSpec = {
  name: 'create_discount',
  description: 'Creates a price list entry',
  allowedRoles: ['super_admin', 'owner'],
  allowDuringImpersonation: false,
};

test('no actor (unauthenticated) can never execute any tool', () => {
  assert.equal(canExecuteTool(SAFE_TOOL, null), false);
  assert.equal(canExecuteTool(SENSITIVE_TOOL, null), false);
});

test('a role not in allowedRoles is rejected even for a safe tool', () => {
  const actor: AssistantActor = { role: 'staff', impersonating: false };
  // staff IS allowed on SAFE_TOOL but not SENSITIVE_TOOL
  assert.equal(canExecuteTool(SAFE_TOOL, actor), true);
  assert.equal(canExecuteTool(SENSITIVE_TOOL, actor), false);
});

test('an impersonation session is blocked from a tool that disallows impersonation, even with a matching role', () => {
  const actor: AssistantActor = { role: 'owner', impersonating: true };
  assert.equal(canExecuteTool(SENSITIVE_TOOL, actor), false);
});

test('an impersonation session CAN use a tool that explicitly allows it', () => {
  const actor: AssistantActor = { role: 'sales', impersonating: true };
  assert.equal(canExecuteTool(SAFE_TOOL, actor), true);
});

test('a super_admin explicitly impersonating still loses access to a non-impersonation-safe tool', () => {
  const actor: AssistantActor = { role: 'super_admin', impersonating: true };
  assert.equal(canExecuteTool(SENSITIVE_TOOL, actor), false);
});

test('toolsVisibleToActor filters the list down before any prompt is built', () => {
  const staffActor: AssistantActor = { role: 'staff', impersonating: false };
  const visible = toolsVisibleToActor([SAFE_TOOL, SENSITIVE_TOOL], staffActor);
  assert.deepEqual(visible.map((t) => t.name), ['audit_seo']);
});

test('toolsVisibleToActor returns an empty list for a null actor', () => {
  assert.deepEqual(toolsVisibleToActor([SAFE_TOOL, SENSITIVE_TOOL], null), []);
});

test('parseToolCall accepts a well-formed tool-call JSON object', () => {
  const result = parseToolCall('{"tool": "audit_seo", "args": {"limit": 10}}');
  assert.deepEqual(result, { tool: 'audit_seo', args: { limit: 10 } });
});

test('parseToolCall strips a markdown code fence the model added despite instructions', () => {
  const result = parseToolCall('```json\n{"tool": "audit_seo", "args": {}}\n```');
  assert.deepEqual(result, { tool: 'audit_seo', args: {} });
});

test('parseToolCall defaults args to {} when absent or malformed', () => {
  assert.deepEqual(parseToolCall('{"tool": "audit_seo"}'), { tool: 'audit_seo', args: {} });
  assert.deepEqual(parseToolCall('{"tool": "audit_seo", "args": "not an object"}'), { tool: 'audit_seo', args: {} });
});

test('parseToolCall rejects non-JSON, arrays, and objects missing a string tool field', () => {
  assert.equal(parseToolCall('not json at all'), null);
  assert.equal(parseToolCall('[]'), null);
  assert.equal(parseToolCall('{"args": {}}'), null);
  assert.equal(parseToolCall('{"tool": 123}'), null);
  assert.equal(parseToolCall(''), null);
});

test('parseToolCall never executes/evaluates the input — a code-injection payload is just rejected as malformed JSON', () => {
  assert.equal(parseToolCall('{"tool": "x", "args": {}}; require("child_process").exec("rm -rf /")'), null);
});

test('parseToolCall rejects an oversized payload rather than parsing it', () => {
  const huge = '{"tool":"' + 'a'.repeat(30_000) + '"}';
  assert.equal(parseToolCall(huge), null);
});

// One-shot client permission bridge over the existing Approval store, not a
// grant minting API. Bindings are host wiring; authenticated operator approval
// and an atomic current-execution guard provide authority. No tools run here.
import path from 'node:path';
import { copyJson } from '@earendil-works/chord';
import { parametersDigest } from './store.mjs';

const BINDING_FIELDS = ['ownerId', 'source', 'accountId', 'profileId', 'nativeSessionId', 'cwd', 'taskId', 'executionId'];
const TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch']);

function bindingSnapshot(input) {
  const value = copyJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== BINDING_FIELDS.length ||
      BINDING_FIELDS.some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 1024) ||
      !path.isAbsolute(value.cwd) || path.resolve(value.cwd) !== value.cwd) throw new Error('invalid ACP host binding');
  return Object.freeze(value);
}

export function acpPermissionPlan(binding, params) {
  const scope = bindingSnapshot(binding);
  const request = copyJson(params, { omitUndefinedProperties: true });
  const tool = request?.toolCall;
  if (request?.sessionId !== scope.nativeSessionId || typeof tool?.toolCallId !== 'string' || !tool.toolCallId ||
      !TOOL_KINDS.has(tool.kind) || !tool.rawInput || typeof tool.rawInput !== 'object' || Array.isArray(tool.rawInput) ||
      !Array.isArray(request.options) || request.options.length > 16) throw new Error('unverifiable ACP permission request');
  const allowed = request.options.filter(option => option.kind === 'allow_once' && typeof option.optionId === 'string' && option.optionId.length > 0);
  if (allowed.length !== 1 || request.options.filter(option => option.optionId === allowed[0].optionId).length !== 1) throw new Error('ambiguous ACP permission option');
  const parameters = { scope, toolCall: tool, optionId: allowed[0].optionId };
  return { action: 'acp.tool.permission', target: `acp:${parametersDigest([scope.source, scope.nativeSessionId, tool.toolCallId]).slice(7)}`,
    parameters, parametersDigest: parametersDigest(parameters), requiresApproval: true };
}

export function createAcpPermissionBroker({ store, binding, findApprovalId } = {}) {
  const scope = bindingSnapshot(binding);
  if (!store || typeof store.consumeApproval !== 'function' || typeof findApprovalId !== 'function') throw new Error('ACP approval broker is not configured');
  return Object.freeze({ async authorizePermission(params) {
    try {
      const plan = acpPermissionPlan(scope, params);
      // This resolver is trusted host code. A model-supplied approvalId is never used.
      const approvalId = await findApprovalId(plan);
      if (typeof approvalId !== 'string' || !approvalId) return undefined;
      const consumed = await store.consumeApproval(approvalId, { action: plan.action, target: plan.target, parametersDigest: plan.parametersDigest }, {
        idempotencyKey: `acp-permission:${parametersDigest([scope.executionId, plan.parametersDigest])}`,
        requireOperator: true, executionGuard: scope,
      });
      // Permission delivery may have occurred before a crash. Never replay an
      // allow response merely because the store can replay its receipt.
      return consumed.replay ? undefined : plan.parameters.optionId;
    } catch { return undefined; }
  } });
}

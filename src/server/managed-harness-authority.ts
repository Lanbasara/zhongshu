import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Binding, HarnessId, HarnessInput } from '../harness/types.ts';
import { nativeText } from '../shared/content.ts';
import { stateSchema } from '../shared/workbench.ts';
import type { AsyncWorkbenchStore } from './storage-client.ts';
import type { AsyncExecutionStore } from './execution-store.ts';
import type { WorkspaceRegistry } from './workspace-registry.ts';
import { StoreError, type Conversation } from './workbench-store.ts';
import type { ExecutionGatewayAuthority, GatewayRequest, NativeInvocation } from './execution-host.ts';
import type { HostPermission } from './execution-host-ledger.ts';
import { pluginCommand, pluginSourceCommand } from '../shared/plugins.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const baselineObservationId = (groupId: string, through: number, conversationId: string, bindingId: string) => 'baseline-' + hash([groupId, through, conversationId, bindingId]);
const bindingSchema = z.object({ id: z.string().min(1).max(1024), cwd: z.string().min(1).max(4096),
  configuration: z.object({ modelId: z.string().min(1).max(2048), permissionId: z.string().min(1).max(128) }).strict(), details: z.record(z.string(), z.unknown()),
}).strict();

/** Resolve only durable, authenticated business identities. The native payload
 * is rebuilt from immutable operations/resources; no caller supplies a binding,
 * model, directory, image data or replacement prompt to the gateway.
 */
export function createManagedHarnessAuthority(input: { groupId: string; harnessId: HarnessId; store: AsyncWorkbenchStore; execution: AsyncExecutionStore; registry: WorkspaceRegistry }): ExecutionGatewayAuthority {
  const { store, execution, registry, groupId, harnessId } = input;
  async function conversation(id: string): Promise<Conversation> {
    const value = await store.getConversation(id);
    if (!value || value.harnessId !== harnessId) throw new StoreError('execution_conversation_unavailable', 404);
    const workspace = await registry.get(value.workspaceId);
    if (!workspace || workspace.removed || workspace.directory !== value.cwd) throw new StoreError('execution_workspace_unavailable', 409);
    registry.verify(workspace);
    if (!(await execution.workspaceGroups(value.workspaceId)).includes(groupId)) throw new StoreError('execution_workspace_unmanaged', 409);
    return value;
  }
  function binding(value: Conversation): Binding { if (!value.binding) throw new StoreError('execution_binding_unverified', 409); return value.binding; }
  const toPermission = (invocation: NativeInvocation, wireDigest: string, permit: { admissionId?: string; contentDigest: string; groups: HostPermission['groups'] }): HostPermission => {
    if (!permit.groups.some(group => group.groupId === groupId)) throw new StoreError('execution_forward_group_missing', 409);
    return { requestId: invocation.requestId, admissionId: permit.admissionId ?? 'stop:' + invocation.operationId!, contentDigest: permit.contentDigest, wireDigest,
      groups: permit.groups, purpose: invocation.method === 'stop' ? 'stop' : 'execute' };
  };
  return {
    async resolve(request: GatewayRequest): Promise<NativeInvocation> {
      if (request.kind === 'plugin') {
        const admission = await execution.hostAdmission(request.operationId);
        if (!admission || admission.harnessId !== harnessId) throw new StoreError('execution_host_operation_unavailable', 404);
        const command = admission.kind === 'plugin' ? pluginCommand.parse(admission.command) : pluginSourceCommand.parse(admission.command);
        return { requestId: 'plugin:' + request.operationId, operationId: request.operationId, harnessId,
          method: admission.kind === 'plugin' ? 'pluginChange' : 'pluginSource', args: admission.kind === 'plugin' ? [command] : [command, request.operationId] };
      }
      if (request.kind === 'create') {
        const value = await conversation(request.conversationId);
        return { requestId: 'create:' + value.id, conversationId: value.id, workspaceId: value.workspaceId, harnessId, method: 'create',
          args: [{ cwd: value.cwd, configuration: value.configuration, title: value.title }] };
      }
      if (request.kind === 'observe') {
        const value = await conversation(request.conversationId); const nativeBinding = binding(value);
        if (request.method === 'reconcile') {
          const original = request.operationId ? await store.getOperation(request.operationId) : null;
          if (!original || original.conversationId !== value.id || original.type !== 'message') throw new StoreError('execution_observation_identity_changed', 409);
        }
        const requestId = request.context?.baseline ? baselineObservationId(request.context.baseline.groupId, request.context.baseline.through, value.id, nativeBinding.id) : request.requestId;
        return { requestId, conversationId: value.id, workspaceId: value.workspaceId, harnessId, method: request.method, observation: request,
          args: request.method === 'state' ? [nativeBinding, request.targetRunId] : request.method === 'reconcile' ? [nativeBinding, request.operationId] : [nativeBinding] };
      }
      const operation = await store.getOperation(request.operationId);
      if (!operation) throw new StoreError('operation_not_found', 404);
      const value = await conversation(operation.conversationId); const nativeBinding = binding(value);
      if (request.kind === 'wake') {
        if (operation.type !== 'message' || !operation.queuedInput || operation.status !== 'accepted') throw new StoreError('execution_wake_unregistered', 409);
        return { requestId: request.requestId, conversationId: value.id, workspaceId: value.workspaceId, harnessId, operationId: operation.id, method: 'wakeQueued', args: [nativeBinding, operation.id] };
      }
      if (operation.type === 'stop') return { requestId: operation.id, operationId: operation.id, conversationId: value.id, workspaceId: value.workspaceId,
        harnessId, method: 'stop', args: [nativeBinding, operation.payload.runId] };
      const imageData = operation.payload.images ? await Promise.all(operation.payload.images.map(async image => {
        const stored = await store.resources.get(value.id, image.id);
        if (stored.name !== image.name || stored.mediaType !== image.mediaType) throw new StoreError('image_reference_changed', 409);
        return { mediaType: stored.mediaType, data: stored.data.toString('base64') };
      })) : undefined;
      const nativeInput: HarnessInput = { ...operation.payload, id: operation.id, text: nativeText(operation.payload), ...(imageData ? { imageData } : {}) };
      return { requestId: operation.id, operationId: operation.id, conversationId: value.id, workspaceId: value.workspaceId, harnessId,
        method: operation.queuedInput ? 'submitQueued' : 'submit', args: operation.queuedInput ? [nativeBinding, nativeInput, operation.queuedInput.delivery] : [nativeBinding, nativeInput] };
    },
    async authorize(invocation, wireDigest) {
      if (invocation.method === 'pluginChange' || invocation.method === 'pluginSource') return toPermission(invocation, wireDigest, await execution.bindHostPluginRequest({ operationId: invocation.operationId, wireDigest }));
      if (invocation.method === 'stop') return toPermission(invocation, wireDigest, await execution.permissionForStop({ operationId: invocation.operationId!, bindingId: (invocation.args[0] as Binding).id, runId: String(invocation.args[1]), wireDigest }));
      if (invocation.method === 'wakeQueued') return toPermission(invocation, wireDigest, await execution.bindAssociatedRequest({ operationId: invocation.operationId!, requestId: invocation.requestId, kind: 'wake', wireDigest }));
      if (invocation.method === 'submit' || invocation.method === 'submitQueued') return toPermission(invocation, wireDigest, await execution.bindNativeRequest(invocation.operationId!, wireDigest));
      if (!invocation.conversationId || !invocation.workspaceId) throw new StoreError('execution_invocation_invalid', 409);
      const context = invocation.observation?.context;
      if (context?.baseline) return toPermission(invocation, wireDigest, await execution.registerBaselineObservation({ ...context.baseline, conversationId: invocation.conversationId, wireDigest }));
      if (context?.admissionId) {
        const admission = await execution.admission(context.admissionId);
        if (!admission || admission.conversationId !== invocation.conversationId || admission.bindingId !== (invocation.args[0] as Binding).id) throw new StoreError('execution_observation_identity_changed', 409);
        return toPermission(invocation, wireDigest, await execution.bindObservationRequest({ admissionId: context.admissionId, requestId: invocation.requestId, wireDigest }));
      }
      return toPermission(invocation, wireDigest, await execution.registerNative({ sourceKey: invocation.requestId, workspaceId: invocation.workspaceId, conversationId: invocation.conversationId,
        ...(invocation.method === 'create' ? {} : { bindingId: (invocation.args[0] as Binding).id }), purpose: invocation.method === 'create' ? 'create' : 'execute', wireDigest }));
    },
    async onBound(invocation, raw, permission) {
      if (invocation.method !== 'create') throw new StoreError('execution_unexpected_binding', 409);
      const value = await conversation(invocation.conversationId); const received = bindingSchema.parse(raw);
      if (received.cwd !== value.cwd || received.configuration.modelId !== value.configuration.modelId || received.configuration.permissionId !== value.configuration.permissionId)
        throw new StoreError('execution_binding_changed', 409);
      await store.saveBinding(value.id, received); await execution.attachNativeBinding(permission.admissionId);
    },
    async recoverBinding(conversationId, raw) {
      const value = await conversation(conversationId); const received = bindingSchema.parse(raw);
      const admissionId = 'n:' + hash('create:' + conversationId); const admission = await execution.admission(admissionId);
      if (!admission || admission.source !== 'native' || admission.sourceKey !== 'create:' + conversationId || admission.conversationId !== conversationId ||
        received.cwd !== value.cwd || received.configuration.modelId !== value.configuration.modelId || received.configuration.permissionId !== value.configuration.permissionId ||
        value.binding && value.binding.id !== received.id) throw new StoreError('execution_binding_changed', 409);
      await store.saveBinding(value.id, received);
      if (admission.kind !== 'settled') await execution.attachNativeBinding(admissionId);
      return received;
    },
    async onResult(invocation, result, permission) {
      // Only this short observation's own admission can end here. Original
      // operations and baseline checkpoints require their separate exact proofs.
      if (invocation.method !== 'state' || invocation.observation?.context?.admissionId || invocation.observation?.context?.baseline) return;
      const state = stateSchema.safeParse(result);
      if (state.success && state.data.configurationVerified && state.data.status === 'idle' && state.data.pendingInputs === 0)
        await execution.confirmTerminal({ admissionId: permission.admissionId, bindingId: (invocation.args[0] as Binding).id, operationId: null, proof: hash({ requestId: invocation.requestId, state: state.data }) });
    },
    async drained(targetGroupId, frozenSetId) {
      if (targetGroupId !== groupId) return false;
      const page = await execution.pendingPage({ groupId, frozenSetId, limit: 1, byteLimit: 128 * 1024 });
      return page.entries.length === 0 && page.nextCursor === null;
    },
  };
}

export { CanonicalAdmissionQueue } from "./admission-queue.ts";
export {
  AgentSupervisor,
  type AgentSupervisorOptions,
  type AgentConnection,
} from "./agent-supervisor.ts";
export {
  CapabilityBroker,
  type HostCapability,
  type HostCapabilityResult,
  type HostCapabilityContext,
  type CapabilityBrokerRequest,
  type CapabilityBrokerResult,
  type CapabilityApprovalDecision,
  type CapabilityApprovalHandler,
  type CapabilityPolicyHookResult,
  type CapabilityHookCoordinator,
} from "./capability-broker.ts";
export {
  HostApplicationService,
  type HostApplicationServiceOptions,
  type ApplicationAgentControl,
} from "./application-service.ts";
export { HostApplicationController } from "./application-controller.ts";
export {
  CognitionGateway,
  type VerificationPlanMatch,
  type VerificationEvaluation,
} from "./cognition-gateway.ts";
export { COGNITION_TOOL_NAMES, HostCognitionService } from "./cognition-service.ts";
export { HostContextSourceReader } from "./context-source.ts";
export {
  HostContextService,
  type HostContextServiceOptions,
  type RefreshContextInput,
} from "./context-service.ts";
export {
  DefaultHostPolicy,
  type HostPolicy,
  type CapabilityAuthorization,
  type CapabilityAuthorizationRequest,
} from "./policy.ts";
export {
  HostSessionManager,
  HostSessionStateError,
  type HostSessionState,
  type HostSessionHandle,
  type CompletionEvidence,
} from "./session-manager.ts";
export { TranscriptAdmissionService } from "./transcript-admission.ts";
export {
  ContextIncompleteError,
  compileVerbatimContext,
  assertContextContinuable,
} from "./verbatim-context.ts";
export { DurableWorkDispatcher, type MemoryConsolidationWork } from "./work-dispatcher.ts";
export { createChildProcessHostTransport, createProcessAgentTransport } from "./node-ipc-transport.ts";
export { HostRuntime, type HostRuntimeOptions, type AttachedAgent, type AgentResumeReason } from "./host.ts";
export {
  ExternalProcessSupervisor,
  scrubExternalProcessEnvironment,
  type ExternalProcessSpec,
  type ExternalProcessExit,
  type OwnedExternalProcess,
  type ExternalProcessSupervisorOptions,
} from "./external-process.ts";
export {
  HostArtifactStore,
  type HostArtifactReference,
  type RetainArtifactOptions,
  type HostArtifactStoreOptions,
} from "./artifact-store.ts";
export {
  createSafeFetch,
  classifyNetworkAddress,
  DefaultHostDnsResolver,
  NodePinnedHttpDriver,
  type ResolvedHostAddress,
  type HostDnsResolver,
  type HostHttpDriverRequest,
  type HostHttpDriver,
  type SafeFetchOptions,
} from "./safe-network.ts";
export {
  HostPluginService,
  type HostPluginStatus,
  type HostPluginRegistration,
  type PluginRuntimeActivation,
  type HostPluginLifecycle,
  type HostPluginServiceOptions,
} from "./plugin-service.ts";
export { HostPluginApplicationService } from "./plugin-application-service.ts";
export {
  HostMcpManager,
  type HostMcpRuntimeStatus,
  type HostMcpDiagnostic,
  type HostMcpManagerOptions,
} from "./mcp-manager.ts";
export {
  HostHookManager,
  type HostHookAuditRecord,
  type HostHookManagerOptions,
  type CapabilityPolicyHookRequest,
} from "./hook-manager.ts";
export { createCapabilityHookCoordinator } from "./hook-coordinator.ts";
export { createCodeIntelligenceCapability, createOwnedTypeScriptLanguageServerProvider } from "./code-intelligence.ts";

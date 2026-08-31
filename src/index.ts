export { runExplorer } from "./runtime/run.js";
export type { RunExplorerOptions } from "./runtime/run.js";
export type {
  ExplorerSessionCapture,
  ExplorerSessionCaptureHandler,
} from "./runtime/session-capture.js";
export { resolveConfig, redactSecret, redactUrl } from "./config.js";
export { createWorkspace } from "./tools/workspace.js";
export { compileFreeContextResult } from "./output/evidence.js";
export {
  FREECONTEXT_ELIGIBILITY_POLICY,
  FREECONTEXT_HOST_ROUTE_METADATA,
  FreeContextCallerReentryOriginSchema,
  FreeContextCallerReentryRequestSchema,
  FreeContextCallerReentrySchema,
  FreeContextCallerRequestSchema,
  FreeContextResultSchema,
  LegacyFreeContextResultSchema,
  normalizeFreeContextContinuationRequest,
  normalizeFreeContextRequest,
  serializeForModel,
} from "./mcp/contracts.js";
export { decideFreeContextEligibility, validateFreeContextReentry } from "./mcp/eligibility.js";
export {
  analyzeFreeContextConsumption,
  collectParentRepositoryActions,
} from "./benchmark/consumption-analysis.js";
export {
  adaptHistoricalInvocationProvenanceV1,
  collectInvocationProvenance,
  evaluateFreshInvocationGate,
} from "./benchmark/invocation-provenance.js";
export type {
  FreeContextEligibilityGate,
  FreeContextEligibilityOutcome,
  FreeContextCallContext,
  FreeContextCallerReentry,
  FreeContextCallerReentryOrigin,
  FreeContextCallerReentryRequest,
  FreeContextCallerRequest,
  FreeContextInvocationContext,
  FreeContextResult,
  LegacyFreeContextResult,
} from "./mcp/contracts.js";
export type {
  FreeContextInvocationProvenance,
  FreeContextInvocationAttempt,
  FreeContextInvocationLayer,
  FreeContextInvocationLayerStatus,
  FreeContextInvocationCounts,
  FreeContextHistoricalInvocationProvenanceV1,
  FreeContextFreshInvocationGate,
  FreeContextFreshInvocationGateFailure,
} from "./benchmark/invocation-provenance.js";
export type {
  ForbiddenFreeContextAction,
  FreeContextEligibilityDecision,
  FreeContextEligibilityFacts,
} from "./mcp/eligibility.js";
export type {
  FreeContextConsumptionAudit,
  ParentRepositoryActionEvent,
  ParentRepositoryActionKind,
} from "./benchmark/consumption-analysis.js";
export * from "./errors.js";

/**
 * @module host
 *
 * Public barrel for `@lct/host` — the LCT renderer host-bridge
 * protocol. Re-exports the exact prior flat surface from the cohesive sibling
 * modules: the wire protocol (constants + types), bridge detection/validation,
 * adapter-result normalizers, and the renderer-facing action wrappers. This
 * file contains no logic.
 */

// --- protocol: constant registries + wire types ---
export {
  LCT_HOST_GLOBAL,
  LCT_HOST_VERSION,
  LCT_HOST_APPEARANCE_THEMES,
  LCT_HOST_CLIENT_TYPES,
  LCT_HOST_UPDATER_ACTIONS,
  LCT_HOST_UPDATER_STATES,
} from "./protocol.js";
export type {
  LCTHostClientType,
  LCTHostClient,
  LCTHostFailure,
  LCTHostActionResult,
  LCTHostWorkspaceContext,
  LCTHostProjectImportInit,
  LCTHostProjectImportSuccess,
  LCTHostProjectImportResult,
  LCTHostProjectReplaceWorkingDirSuccess,
  LCTHostProjectReplaceWorkingDirResult,
  LCTHostPickWorkingDirSuccess,
  LCTHostPickWorkingDirResult,
  LCTHostPdfPrintOptions,
  LCTHostCaptureClip,
  LCTHostCaptureOptions,
  LCTHostCaptureSuccess,
  LCTHostCaptureResult,
  LCTHostPreviewNavigationFailure,
  LCTHostPreviewNavigationFailureListener,
  LCTHostAppearanceTheme,
  LCTHostBrowserClearDataOptions,
  LCTHostUpdaterAction,
  LCTHostUpdaterState,
  LCTHostUpdaterMode,
  LCTHostUpdaterChannel,
  LCTHostUpdaterActionOptions,
  LCTHostUpdaterCapabilitySet,
  LCTHostUpdaterPathSnapshot,
  LCTHostUpdaterChecksumSnapshot,
  LCTHostUpdaterArtifactSnapshot,
  LCTHostUpdaterProgressSnapshot,
  LCTHostUpdaterErrorSnapshot,
  LCTHostUpdaterInstallResult,
  LCTHostUpdaterReleaseSnapshot,
  LCTHostUpdaterIncomingSnapshot,
  LCTHostUpdaterCacheLifecycleTrigger,
  LCTHostUpdaterReleaseLifecycleState,
  LCTHostUpdaterCacheLifecycleSummary,
  LCTHostUpdaterCacheSnapshot,
  LCTHostUpdaterReinstallReason,
  LCTHostUpdaterReinstallSnapshot,
  LCTHostUpdaterStatusSnapshot,
  LCTHostUpdaterResult,
  LCTHostUpdaterStatusListener,
  LCTHostUpdaterMenuLabels,
  LCTHostUpdaterOpenDialogRequest,
  LCTHostUpdaterOpenDialogListener,
  LCTHostBridge,
  LCTHostGlobalScope,
} from "./protocol.js";

// --- detection: locate + validate the injected bridge ---
export {
  isLCTHostBridge,
  getLCTHost,
  isLCTHostAvailable,
  detectLCTHostClientType,
} from "./detection.js";

// --- normalize: adapter result -> renderer contract ---
export {
  normalizeLCTHostProjectImportResult,
  normalizeLCTHostProjectReplaceWorkingDirResult,
  normalizeLCTHostPickWorkingDirResult,
} from "./normalize.js";

// --- actions: renderer-facing host action wrappers ---
export {
  openHostExternalUrl,
  openHostProjectPath,
  clearHostBrowserData,
  captureHostPage,
  pickAndImportHostProject,
  pickAndReplaceHostProjectWorkingDir,
  pickHostWorkingDir,
  printHostPdf,
  setHostPetVisible,
  getHostUpdaterStatus,
  checkHostUpdater,
  clearHostUpdaterCache,
  downloadHostUpdater,
  installHostUpdater,
  quitHostAfterUpdaterInstallerOpen,
  getLatestHostPreviewNavigationFailure,
  subscribeHostUpdater,
  subscribeHostUpdaterOpenDialog,
  subscribeHostPreviewNavigationFailure,
  setHostUpdaterMenuLabels,
} from "./actions.js";

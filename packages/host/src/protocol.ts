import type { ReleaseChannel } from "@lct/release";

/**
 * @module protocol
 *
 * The LCT renderer host-bridge wire contract: the injected-global name
 * and version, client/updater constant registries, and every request/result
 * type that crosses the host bridge — including the {@link LCTHostBridge}
 * shape itself. Pure declarations only; depends on nothing else in the package.
 */

export const LCT_HOST_GLOBAL = "__od__";
export const LCT_HOST_VERSION = 2;

export const LCT_HOST_CLIENT_TYPES = Object.freeze({
  DESKTOP: "desktop",
} as const);

export type LCTHostClientType =
  (typeof LCT_HOST_CLIENT_TYPES)[keyof typeof LCT_HOST_CLIENT_TYPES];

export type LCTHostClient = {
  // BCP-47 locale string (e.g. "zh-CN", "pt-BR") the host process read from
  // the OS at startup. The renderer uses this so the packaged desktop app
  // can follow the OS language even when Chromium's built-in
  // `navigator.language` would have defaulted to en-US.
  osLocale?: string;
  platform?: string;
  type: LCTHostClientType;
};

export type LCTHostFailure = {
  details?: unknown;
  ok: false;
  reason: string;
};

export type LCTHostActionResult =
  | { ok: true }
  | LCTHostFailure;

/**
 * The workspace attribution the renderer gives the host so a folder import
 * lands in the caller's current workspace instead of the host's ambient one.
 *
 * This is a deliberate structural subset of the daemon/web
 * `WorkspaceCollabContext`, redeclared here rather than imported: this package
 * is the renderer host-bridge wire contract and must stay independent of the
 * daemon/web contracts package (enforced by the "stays independent from
 * daemon/web contracts" test). A full `WorkspaceCollabContext` is structurally
 * assignable to this type, so callers pass theirs unchanged.
 *
 * Only the fields the host actually forwards are modelled, and the enum-like
 * fields stay `string` because the host treats them as opaque pass-through
 * values — the daemon remains the authority that parses and validates them.
 * Deliberately no index signature: an interface never satisfies one, so adding
 * it would reject the very `WorkspaceCollabContext` callers pass. Callers hand
 * over a variable, not a fresh literal, so the extra fields ride along fine.
 */
export type LCTHostWorkspaceContext = {
  lifecycleState: string;
  memberStatus: string;
  permissions: {
    canShareProjects: boolean;
    canWriteSyncedFiles: boolean;
  };
  role: string;
  workspaceId: string;
  workspaceMemberId: string;
  workspaceType: string;
};

export type LCTHostProjectImportInit = {
  designSystemId?: string | null;
  name?: string;
  skillId?: string | null;
  workspaceContext?: LCTHostWorkspaceContext | null;
};

export type LCTHostProjectImportSuccess = {
  conversationId: string;
  entryFile: string | null;
  ok: true;
  projectId: string;
};

export type LCTHostProjectImportResult =
  | LCTHostProjectImportSuccess
  | {
      canceled: true;
      ok: false;
    }
  | LCTHostFailure;

export type LCTHostProjectReplaceWorkingDirSuccess = {
  baseDir: string;
  entryFile: string | null;
  ok: true;
};

export type LCTHostProjectReplaceWorkingDirResult =
  | LCTHostProjectReplaceWorkingDirSuccess
  | {
      canceled: true;
      ok: false;
    }
  | LCTHostFailure;

export type LCTHostPickWorkingDirSuccess = {
  baseDir: string;
  ok: true;
  // Single-use HMAC token (minted by the host main process for `baseDir`)
  // that the renderer threads into POST /api/projects/:id/working-dir once
  // the project exists. Lets the Home flow pick a folder before the project
  // is created without exposing the daemon's desktop-auth gate.
  token: string;
};

export type LCTHostPickWorkingDirResult =
  | LCTHostPickWorkingDirSuccess
  | {
      canceled: true;
      ok: false;
    }
  | LCTHostFailure;

export type LCTHostPdfPrintOptions = {
  deck?: boolean;
};

export type LCTHostCaptureClip = { x: number; y: number; width: number; height: number };
export type LCTHostCaptureOptions = { clip?: LCTHostCaptureClip };
export type LCTHostCaptureSuccess = { dataUrl: string; h: number; ok: true; w: number };
export type LCTHostCaptureResult = LCTHostCaptureSuccess | LCTHostFailure;

export type LCTHostPreviewNavigationFailure = {
  errorCode: number;
  eventId: number;
  frameName?: string;
  occurredAtMs: number;
  validatedUrl: string;
};

export type LCTHostPreviewNavigationFailureListener = (
  failure: LCTHostPreviewNavigationFailure,
) => void;

export type LCTHostBrowserClearDataOptions = {
  cookies?: boolean;
  storage?: boolean;
};

/**
 * App theme values the renderer may pin the host window appearance to.
 * `light`/`dark` force the native window material (macOS under-window
 * vibrancy glass follows the OS appearance by default, which reads as a
 * muddy gray when the OS is dark but the app theme is explicitly light);
 * `system` restores following the OS.
 */
export const LCT_HOST_APPEARANCE_THEMES = Object.freeze({
  DARK: "dark",
  LIGHT: "light",
  SYSTEM: "system",
} as const);

export type LCTHostAppearanceTheme =
  (typeof LCT_HOST_APPEARANCE_THEMES)[keyof typeof LCT_HOST_APPEARANCE_THEMES];

export const LCT_HOST_UPDATER_ACTIONS = Object.freeze({
  CHECK: "check",
  CLEAR_CACHE: "clear-cache",
  DOWNLOAD: "download",
  INSTALL: "install",
  QUIT: "quit",
  STATUS: "status",
} as const);

export type LCTHostUpdaterAction =
  (typeof LCT_HOST_UPDATER_ACTIONS)[keyof typeof LCT_HOST_UPDATER_ACTIONS];

/** @internal Updater actions that return a status snapshot (every action except `quit`). */
export type LCTHostUpdaterStatusAction = Exclude<
  LCTHostUpdaterAction,
  typeof LCT_HOST_UPDATER_ACTIONS.QUIT
>;

export const LCT_HOST_UPDATER_STATES = Object.freeze({
  AVAILABLE: "available",
  CHECKING: "checking",
  DOWNLOADED: "downloaded",
  DOWNLOADING: "downloading",
  ERROR: "error",
  IDLE: "idle",
  INSTALLING: "installing",
  NOT_AVAILABLE: "not-available",
  UNSUPPORTED: "unsupported",
} as const);

export type LCTHostUpdaterState =
  (typeof LCT_HOST_UPDATER_STATES)[keyof typeof LCT_HOST_UPDATER_STATES];

export type LCTHostUpdaterMode = "js-incremental" | "package-launcher";
export type LCTHostUpdaterChannel = ReleaseChannel;

export type LCTHostUpdaterActionOptions = {
  payload?: Record<string, unknown>;
};

export type LCTHostUpdaterCapabilitySet = {
  canApplyInPlace: boolean;
  canDownload: boolean;
  canOpenInstaller: boolean;
  requiresManualInstall: boolean;
};

export type LCTHostUpdaterPathSnapshot = {
  downloadRoot?: string;
  manifestPath?: string;
};

export type LCTHostUpdaterChecksumSnapshot = {
  algorithm: "sha256" | "sha512";
  url?: string;
  value?: string;
};

export type LCTHostUpdaterArtifactSnapshot = {
  name?: string;
  platformKey?: string;
  size?: number;
  type?: string;
  url: string;
};

export type LCTHostUpdaterProgressSnapshot = {
  receivedBytes: number;
  totalBytes?: number;
};

export type LCTHostUpdaterErrorSnapshot = {
  code: string;
  details?: unknown;
  message: string;
};

export type LCTHostUpdaterInstallResult = {
  activeVersion?: string;
  artifactPath?: string;
  dryRun?: boolean;
  helperLogPath?: string;
  launcherRuntimePath?: string;
  launchPath?: string;
  openedAt: string;
  path: string;
};

export type LCTHostUpdaterReleaseSnapshot = {
  arch: string;
  artifact: LCTHostUpdaterArtifactSnapshot;
  checksum: LCTHostUpdaterChecksumSnapshot;
  channel: LCTHostUpdaterChannel;
  downloadedAt: string;
  key: string;
  metadata?: Record<string, unknown>;
  path: string;
  platformKey: string;
  version: string;
};

export type LCTHostUpdaterIncomingSnapshot = {
  arch: string;
  artifact: LCTHostUpdaterArtifactSnapshot;
  channel: LCTHostUpdaterChannel;
  key?: string;
  metadata?: Record<string, unknown>;
  progress?: LCTHostUpdaterProgressSnapshot;
  startedAt: string;
  version: string;
};

export type LCTHostUpdaterCacheLifecycleTrigger = "cold-start" | "manual" | "next-version-ready";

export type LCTHostUpdaterReleaseLifecycleState =
  | "cleanup-deferred"
  | "cleanup-removed"
  | "deprecated"
  | "retained"
  | "unknown";

export type LCTHostUpdaterCacheLifecycleSummary = {
  lastRunAt?: string;
  lastTrigger?: LCTHostUpdaterCacheLifecycleTrigger;
  platform: string;
  releases: {
    cleanupDeferred: number;
    cleanupRemoved: number;
    deprecated: number;
    errors: number;
    retained: number;
    total: number;
    unknown: number;
  };
};

export type LCTHostUpdaterCacheSnapshot = {
  lifecycle?: LCTHostUpdaterCacheLifecycleSummary;
};

export type LCTHostUpdaterReinstallReason =
  | "launcher-schema"
  | "outer-below-min"
  | "outer-version-unreadable";

/**
 * Present when the release feed requires a full installer reinstall instead of
 * an in-place payload update. `installedVersion` is the physically installed
 * outer package version; `url` is an optional operator-supplied explanation
 * link.
 */
export type LCTHostUpdaterReinstallSnapshot = {
  installedVersion?: string;
  minVersion?: string;
  reason: LCTHostUpdaterReinstallReason;
  url?: string;
};

export type LCTHostUpdaterStatusSnapshot = {
  active?: LCTHostUpdaterReleaseSnapshot;
  arch: string;
  artifact?: LCTHostUpdaterArtifactSnapshot;
  artifactUrl?: string;
  availableVersion?: string;
  cache?: LCTHostUpdaterCacheSnapshot;
  capabilities: LCTHostUpdaterCapabilitySet;
  channel: LCTHostUpdaterChannel;
  checksum?: LCTHostUpdaterChecksumSnapshot;
  currentVersion: string;
  downloadPath?: string;
  enabled: boolean;
  error?: LCTHostUpdaterErrorSnapshot;
  incoming?: LCTHostUpdaterIncomingSnapshot;
  installResult?: LCTHostUpdaterInstallResult;
  lastCheckedAt?: string;
  metadata?: Record<string, unknown>;
  mode: LCTHostUpdaterMode;
  paths?: LCTHostUpdaterPathSnapshot;
  platform: string;
  progress?: LCTHostUpdaterProgressSnapshot;
  reinstall?: LCTHostUpdaterReinstallSnapshot;
  state: LCTHostUpdaterState;
  supported: boolean;
};

export type LCTHostUpdaterResult =
  | { ok: true; status: LCTHostUpdaterStatusSnapshot }
  | LCTHostFailure;

export type LCTHostUpdaterStatusListener = (status: LCTHostUpdaterStatusSnapshot) => void;

export type LCTHostUpdaterMenuLabels = {
  check: string;
  checking: string;
  downloading: string;
  install: string;
  installing: string;
  restart: string;
};

export type LCTHostUpdaterOpenDialogRequest = {
  source: string;
};

export type LCTHostUpdaterOpenDialogListener = (request: LCTHostUpdaterOpenDialogRequest) => void;

export type LCTHostBridge = {
  // Optional so older host builds still satisfy the bridge shape; callers
  // must feature-detect before invoking.
  appearance?: {
    setTheme(theme: LCTHostAppearanceTheme): void;
  };
  browser: {
    clearData(options?: LCTHostBrowserClearDataOptions): Promise<LCTHostActionResult>;
  };
  capture: {
    page(options?: LCTHostCaptureOptions): Promise<LCTHostCaptureResult>;
  };
  client: LCTHostClient;
  pdf: {
    print(html: string, nonce?: string, options?: LCTHostPdfPrintOptions): Promise<LCTHostActionResult>;
  };
  pet: {
    setVisible(visible: boolean): void;
  };
  // Optional so web builds and older desktop hosts keep the same contract.
  // Electron is the only layer that can observe a compositor-affecting
  // subframe navigation failure after the iframe DOM remains healthy.
  preview?: {
    getLatestNavigationFailure(): LCTHostPreviewNavigationFailure | null;
    subscribeNavigationFailure(listener: LCTHostPreviewNavigationFailureListener): () => void;
  };
  project: {
    pickAndImport(init?: LCTHostProjectImportInit): Promise<LCTHostProjectImportResult>;
    pickAndReplaceWorkingDir(projectId: string): Promise<LCTHostProjectReplaceWorkingDirResult>;
    // Optional so older host builds still satisfy the bridge shape; callers
    // must feature-detect before invoking.
    pickWorkingDir?(): Promise<LCTHostPickWorkingDirResult>;
  };
  shell: {
    openExternal(url: string): Promise<LCTHostActionResult>;
    openPath(projectId: string): Promise<LCTHostActionResult>;
  };
  // Desktop only. Absent in Web and old clients; callers must fail closed.
  updater: {
    check(options?: LCTHostUpdaterActionOptions): Promise<LCTHostUpdaterStatusSnapshot>;
    "clear-cache"(options?: LCTHostUpdaterActionOptions): Promise<LCTHostUpdaterStatusSnapshot>;
    download(options?: LCTHostUpdaterActionOptions): Promise<LCTHostUpdaterStatusSnapshot>;
    install(options?: LCTHostUpdaterActionOptions): Promise<LCTHostUpdaterStatusSnapshot>;
    quit(options?: LCTHostUpdaterActionOptions): Promise<LCTHostActionResult>;
    setMenuLabels(labels: LCTHostUpdaterMenuLabels): Promise<LCTHostActionResult>;
    status(options?: LCTHostUpdaterActionOptions): Promise<LCTHostUpdaterStatusSnapshot>;
    subscribe(listener: LCTHostUpdaterStatusListener): () => void;
    subscribeOpenDialog(listener: LCTHostUpdaterOpenDialogListener): () => void;
  };
  version: typeof LCT_HOST_VERSION;
};

export type LCTHostGlobalScope = Record<string, unknown> & {
  window?: unknown;
};

import {
  LCT_HOST_GLOBAL,
  LCT_HOST_VERSION,
  type LCTHostBridge,
  type LCTHostGlobalScope,
  type LCTHostUpdaterStatusSnapshot,
} from "./index.js";

export type MockLCTHost = Partial<Omit<LCTHostBridge, "capture" | "client" | "pdf" | "pet" | "preview" | "project" | "shell" | "updater">> & {
  browser?: Partial<LCTHostBridge["browser"]>;
  capture?: Partial<LCTHostBridge["capture"]>;
  client?: Partial<LCTHostBridge["client"]>;
  pdf?: Partial<LCTHostBridge["pdf"]>;
  pet?: Partial<LCTHostBridge["pet"]>;
  preview?: Partial<NonNullable<LCTHostBridge["preview"]>>;
  project?: Partial<LCTHostBridge["project"]>;
  shell?: Partial<LCTHostBridge["shell"]>;
  updater?: Partial<LCTHostBridge["updater"]>;
};

export type MockLCTHostOptions = {
  host?: MockLCTHost;
  scope?: LCTHostGlobalScope;
};

function defaultHost(): LCTHostBridge {
  const updaterStatus: LCTHostUpdaterStatusSnapshot = {
    arch: "arm64",
    capabilities: {
      canApplyInPlace: false,
      canDownload: true,
      canOpenInstaller: true,
      requiresManualInstall: true,
    },
    channel: "beta",
    currentVersion: "1.0.0-beta.0",
    enabled: true,
    mode: "package-launcher",
    platform: "darwin",
    state: "idle",
    supported: true,
  };
  return {
    version: LCT_HOST_VERSION,
    browser: {
      clearData: async () => ({ ok: true }),
    },
    capture: {
      page: async () => ({ ok: true, dataUrl: "data:image/png;base64,", h: 1, w: 1 }),
    },
    client: {
      type: "desktop",
      platform: "test",
    },
    shell: {
      openExternal: async () => ({ ok: true }),
      openPath: async () => ({ ok: true }),
    },
    project: {
      pickAndImport: async () => ({
        ok: true,
        projectId: "project-test",
        conversationId: "conversation-test",
        entryFile: "index.html",
      }),
      pickAndReplaceWorkingDir: async () => ({
        ok: true,
        baseDir: "/tmp/lct-test",
        entryFile: null,
      }),
    },
    pdf: {
      print: async () => ({ ok: true }),
    },
    pet: {
      setVisible: () => undefined,
    },
    preview: {
      getLatestNavigationFailure: () => null,
      subscribeNavigationFailure: () => () => undefined,
    },
    updater: {
      check: async () => updaterStatus,
      "clear-cache": async () => updaterStatus,
      download: async () => updaterStatus,
      install: async () => updaterStatus,
      quit: async () => ({ ok: true }),
      setMenuLabels: async () => ({ ok: true }),
      status: async () => updaterStatus,
      subscribe: () => () => undefined,
      subscribeOpenDialog: () => () => undefined,
    },
  };
}

export function createMockLCTHost(overrides: MockLCTHost = {}): LCTHostBridge {
  const base = defaultHost();
  return {
    ...base,
    ...overrides,
    browser: { ...base.browser, ...overrides.browser },
    capture: { ...base.capture, ...overrides.capture },
    client: { ...base.client, ...overrides.client },
    shell: { ...base.shell, ...overrides.shell },
    project: { ...base.project, ...overrides.project },
    pdf: { ...base.pdf, ...overrides.pdf },
    pet: { ...base.pet, ...overrides.pet },
    preview: {
      getLatestNavigationFailure:
        overrides.preview?.getLatestNavigationFailure
        ?? base.preview!.getLatestNavigationFailure,
      subscribeNavigationFailure:
        overrides.preview?.subscribeNavigationFailure
        ?? base.preview!.subscribeNavigationFailure,
    },
    updater: { ...base.updater, ...overrides.updater },
  };
}

export function installMockLCTHost(options: MockLCTHostOptions = {}): () => void {
  const scope = (options.scope ?? globalThis) as LCTHostGlobalScope;
  const host = createMockLCTHost(options.host);
  const windowValue = scope.window;
  const targets = [
    scope,
    ...(typeof windowValue === "object" && windowValue != null && windowValue !== scope
      ? [windowValue as LCTHostGlobalScope]
      : []),
  ];
  const previous = targets.map((target) => ({
    had: Object.prototype.hasOwnProperty.call(target, LCT_HOST_GLOBAL),
    target,
    value: target[LCT_HOST_GLOBAL],
  }));

  for (const target of targets) {
    Object.defineProperty(target, LCT_HOST_GLOBAL, {
      configurable: true,
      value: host,
      writable: true,
    });
  }

  return () => {
    for (const entry of previous) {
      if (entry.had) {
        Object.defineProperty(entry.target, LCT_HOST_GLOBAL, {
          configurable: true,
          value: entry.value,
          writable: true,
        });
      } else {
        delete entry.target[LCT_HOST_GLOBAL];
      }
    }
  };
}

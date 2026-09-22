export const PRODUCT_NAME = "LCT";
export const DESKTOP_LOG_ECHO_ENV = "OD_DESKTOP_LOG_ECHO";
export const WEB_STANDALONE_HOOK_CONFIG_ENV = "OD_TOOLS_PACK_WEB_STANDALONE_HOOK_CONFIG";
export const WEB_STANDALONE_RESOURCE_NAME = "lct-web-standalone";
export const ELECTRON_BUILDER_ASAR = false;
export const ELECTRON_BUILDER_BUILD_DEPENDENCIES_FROM_SOURCE = false;
export const ELECTRON_BUILDER_NODE_GYP_REBUILD = false;
export const ELECTRON_BUILDER_NPM_REBUILD = false;
export const ELECTRON_REBUILD_MODE = "sequential" as const;
export const ELECTRON_REBUILD_NATIVE_MODULES = ["better-sqlite3"] as const;
export const ELECTRON_BUILDER_FILE_PATTERNS = [
  "**/*",
  "!**/node_modules/.bin",
  "!**/node_modules/electron{,/**/*}",
  "!**/*.map",
  "!**/*.tsbuildinfo",
  "!**/.next/cache",
  "!**/.next/cache/**",
  "!**/node_modules/better-sqlite3/build/Release/obj",
  "!**/node_modules/better-sqlite3/build/Release/obj/**",
  "!**/node_modules/better-sqlite3/deps",
  "!**/node_modules/better-sqlite3/deps/**",
] as const;
export const NSIS_INSTALLER_LANGUAGE_BY_WEB_LOCALE = {
  en: "en_US",
  fa: "fa_IR",
  "pt-BR": "pt_BR",
  ru: "ru_RU",
  "zh-CN": "zh_CN",
  "zh-TW": "zh_TW",
} as const;
export const INTERNAL_PACKAGES = [
  { directory: "packages/release", name: "@lct/release" },
  { directory: "packages/components", name: "@lct/components" },
  { directory: "packages/contracts", name: "@lct/contracts" },
  { directory: "packages/registry-protocol", name: "@lct/registry-protocol" },
  { directory: "packages/sidecar-proto", name: "@lct/sidecar-proto" },
  { directory: "packages/launcher-proto", name: "@lct/launcher-proto" },
  { directory: "packages/platform", name: "@lct/platform" },
  { directory: "packages/sidecar", name: "@lct/sidecar" },
  { directory: "packages/download", name: "@lct/download" },
  { directory: "packages/host", name: "@lct/host" },
  { directory: "packages/agui-adapter", name: "@lct/agui-adapter" },
  { directory: "packages/plugin-runtime", name: "@lct/plugin-runtime" },
  { directory: "packages/diagnostics", name: "@lct/diagnostics" },
  { directory: "apps/daemon", name: "@lct/daemon" },
  { directory: "apps/web", name: "@lct/web" },
  { directory: "apps/desktop", name: "@lct/desktop" },
  { directory: "apps/packaged", name: "@lct/packaged" },
] as const;

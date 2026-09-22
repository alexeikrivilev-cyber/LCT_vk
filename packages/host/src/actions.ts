import { LCT_HOST_UPDATER_ACTIONS } from "./protocol.js";
import type {
  LCTHostActionResult,
  LCTHostBrowserClearDataOptions,
  LCTHostCaptureOptions,
  LCTHostCaptureResult,
  LCTHostFailure,
  LCTHostGlobalScope,
  LCTHostPdfPrintOptions,
  LCTHostPreviewNavigationFailure,
  LCTHostPreviewNavigationFailureListener,
  LCTHostPickWorkingDirResult,
  LCTHostProjectImportInit,
  LCTHostProjectImportResult,
  LCTHostProjectReplaceWorkingDirResult,
  LCTHostUpdaterActionOptions,
  LCTHostUpdaterMenuLabels,
  LCTHostUpdaterOpenDialogListener,
  LCTHostUpdaterResult,
  LCTHostUpdaterStatusAction,
  LCTHostUpdaterStatusListener,
} from "./protocol.js";
import { getLCTHost } from "./detection.js";

/**
 * @module actions
 *
 * Renderer-facing wrappers over the host bridge. Each resolves the bridge from
 * scope, invokes the capability, and returns a host-owned result (or a uniform
 * "host is not available" failure). Covers shell, browser, capture, project,
 * pdf, pet, and the full updater action surface.
 */

/** @internal Build a normalized host failure result. */
function failure(reason: string, details?: unknown): LCTHostFailure {
  return {
    ...(details === undefined ? {} : { details }),
    ok: false,
    reason,
  };
}

/** @internal Uniform failure for when the host bridge is absent. */
function unavailable(reason: string): LCTHostFailure {
  return failure(reason);
}

/** Open an external URL through the host shell. */
export async function openHostExternalUrl(url: string, scope: LCTHostGlobalScope = globalThis): Promise<LCTHostActionResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return await host.shell.openExternal(url);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Reveal a project's path through the host shell. */
export async function openHostProjectPath(projectId: string, scope: LCTHostGlobalScope = globalThis): Promise<LCTHostActionResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return await host.shell.openPath(projectId);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Clear host browser data (cookies and/or storage). */
export async function clearHostBrowserData(
  options?: LCTHostBrowserClearDataOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostActionResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return await host.browser.clearData(options);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Capture the host page (optionally clipped) as a data URL. */
export async function captureHostPage(
  options?: LCTHostCaptureOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostCaptureResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return await host.capture.page(options);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Pick and import a project through the host's native dialog. */
export async function pickAndImportHostProject(
  init?: LCTHostProjectImportInit,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostProjectImportResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return await host.project.pickAndImport(init);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Pick and replace a project's working directory through the host. */
export async function pickAndReplaceHostProjectWorkingDir(
  projectId: string,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostProjectReplaceWorkingDirResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return await host.project.pickAndReplaceWorkingDir(projectId);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

// Picks a folder via the host's native dialog and returns the chosen path
// plus a single-use token, WITHOUT touching any project. The Home flow uses
// this to let the user choose a working directory before the project exists;
// the token is later spent on POST /api/projects/:id/working-dir.
export async function pickHostWorkingDir(
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostPickWorkingDirResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  if (typeof host.project.pickWorkingDir !== "function") {
    return unavailable("host build does not support pickWorkingDir");
  }
  try {
    return await host.project.pickWorkingDir();
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Print HTML to PDF through the host. */
export async function printHostPdf(
  html: string,
  nonce?: string,
  options?: LCTHostPdfPrintOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostActionResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return await host.pdf.print(html, nonce, options);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Toggle host pet visibility. */
export function setHostPetVisible(visible: boolean, scope: LCTHostGlobalScope = globalThis): LCTHostActionResult {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    host.pet.setVisible(visible);
    return { ok: true };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Read the latest Electron-observed preview subframe navigation failure. */
export function getLatestHostPreviewNavigationFailure(
  scope: LCTHostGlobalScope = globalThis,
): LCTHostPreviewNavigationFailure | null {
  const host = getLCTHost(scope);
  if (typeof host?.preview?.getLatestNavigationFailure !== "function") return null;
  try {
    return host.preview.getLatestNavigationFailure();
  } catch {
    return null;
  }
}

/** Subscribe to Electron-observed preview subframe navigation failures. */
export function subscribeHostPreviewNavigationFailure(
  listener: LCTHostPreviewNavigationFailureListener,
  scope: LCTHostGlobalScope = globalThis,
): () => void {
  const host = getLCTHost(scope);
  if (typeof host?.preview?.subscribeNavigationFailure !== "function") return () => undefined;
  try {
    return host.preview.subscribeNavigationFailure(listener);
  } catch {
    return () => undefined;
  }
}

/** @internal Run a status-returning updater action and wrap the result. */
async function runHostUpdaterAction(
  action: LCTHostUpdaterStatusAction,
  options?: LCTHostUpdaterActionOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostUpdaterResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return {
      ok: true,
      status: await host.updater[action](options),
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Get the host updater status. */
export async function getHostUpdaterStatus(
  options?: LCTHostUpdaterActionOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostUpdaterResult> {
  return await runHostUpdaterAction(LCT_HOST_UPDATER_ACTIONS.STATUS, options, scope);
}

/** Trigger a host updater check. */
export async function checkHostUpdater(
  options?: LCTHostUpdaterActionOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostUpdaterResult> {
  return await runHostUpdaterAction(LCT_HOST_UPDATER_ACTIONS.CHECK, options, scope);
}

/** Trigger a host updater download. */
export async function downloadHostUpdater(
  options?: LCTHostUpdaterActionOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostUpdaterResult> {
  return await runHostUpdaterAction(LCT_HOST_UPDATER_ACTIONS.DOWNLOAD, options, scope);
}

/** Clear the host updater/launcher caches and reset one-shot update state. */
export async function clearHostUpdaterCache(
  options?: LCTHostUpdaterActionOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostUpdaterResult> {
  return await runHostUpdaterAction(LCT_HOST_UPDATER_ACTIONS.CLEAR_CACHE, options, scope);
}

/** Trigger a host updater install. */
export async function installHostUpdater(
  options?: LCTHostUpdaterActionOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostUpdaterResult> {
  return await runHostUpdaterAction(LCT_HOST_UPDATER_ACTIONS.INSTALL, options, scope);
}

/** Quit the host after its updater installer has opened. */
export async function quitHostAfterUpdaterInstallerOpen(
  options?: LCTHostUpdaterActionOptions,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostActionResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return await host.updater.quit(options);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/** Subscribe to host updater status changes; returns an unsubscribe fn. */
export function subscribeHostUpdater(
  listener: LCTHostUpdaterStatusListener,
  scope: LCTHostGlobalScope = globalThis,
): () => void {
  const host = getLCTHost(scope);
  if (host == null) return () => undefined;
  try {
    return host.updater.subscribe(listener);
  } catch {
    return () => undefined;
  }
}

/** Subscribe to native host requests to open the updater dialog. */
export function subscribeHostUpdaterOpenDialog(
  listener: LCTHostUpdaterOpenDialogListener,
  scope: LCTHostGlobalScope = globalThis,
): () => void {
  const host = getLCTHost(scope);
  if (host == null) return () => undefined;
  try {
    return host.updater.subscribeOpenDialog(listener);
  } catch {
    return () => undefined;
  }
}

/** Synchronize renderer-localized updater menu labels to the native host. */
export async function setHostUpdaterMenuLabels(
  labels: LCTHostUpdaterMenuLabels,
  scope: LCTHostGlobalScope = globalThis,
): Promise<LCTHostActionResult> {
  const host = getLCTHost(scope);
  if (host == null) return unavailable("LCT host is not available");
  try {
    return await host.updater.setMenuLabels(labels);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

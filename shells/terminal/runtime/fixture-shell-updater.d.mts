import type {
  LifecyclePort,
  LifecycleScope,
  StandaloneLifecycleTransitionPort,
  StandaloneShellUpdaterPort,
} from "@lct/standalone";

export function requireCompleteStandaloneRetirement(
  result: Readonly<{ remainingPids: readonly number[] }> | null,
): void;

export class FixtureShellUpdaterPort implements StandaloneShellUpdaterPort {
  readonly shellType: string;
  constructor(root: string, scope: LifecycleScope, lifecycle: LifecyclePort & StandaloneLifecycleTransitionPort, options?: {
    algebra: typeof import("@lct/standalone").SHELL_UPDATE_ALGEBRA;
    attachmentId?: string;
    channelHeadUrl?: string;
    faultAt?: "after-transition" | "before-handoff-persist";
    installDelayMs?: number;
    withRetiredStandalone?: <T>(input: Readonly<{
      scope: LifecycleScope;
      kind: "shell-install";
      attemptId: string;
      fence: number;
      occupants: readonly import("@lct/standalone").StandaloneLifecycleOccupant[];
    }>, commit: () => Promise<T>) => Promise<T>;
    shellType?: string;
    standalone?: typeof import("@lct/standalone");
    target?: string;
    trustedKeys?: import("@lct/standalone").StandaloneTrustedKeyRing;
  });
  readSnapshot(): ReturnType<StandaloneShellUpdaterPort["readSnapshot"]>;
  waitForChange(afterRevision: number, timeoutMs: number): ReturnType<StandaloneShellUpdaterPort["waitForChange"]>;
  invoke(action: Parameters<StandaloneShellUpdaterPort["invoke"]>[0]): ReturnType<StandaloneShellUpdaterPort["invoke"]>;
  confirmInstalled(...input: Parameters<StandaloneShellUpdaterPort["confirmInstalled"]>): ReturnType<StandaloneShellUpdaterPort["confirmInstalled"]>;
}

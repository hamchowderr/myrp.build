/**
 * FxDK orchestrator resource teardown.
 *
 * Behavior-preserving extraction of the resource-closing actions from
 * FxDkOrchestrator.cleanup. The orchestrator still owns the fields and is
 * responsible for nulling them out after this runs; this helper only performs
 * the exact same ordered close/terminate/dispose actions (reverse order).
 */

import type { LauncherTalk } from "./launcher-talk";
import type { FiveMProcessManager, ProcessHandle } from "./process-manager";
import { closeSemaphore } from "./semaphore";
import type { SharedMemory } from "./shared-memory";

/** Snapshot of the live resources the orchestrator may have allocated. */
export interface FxDkResources {
  launcherTalk: LauncherTalk | null;
  processManager: FiveMProcessManager | null;
  processHandle: ProcessHandle | null;
  produceSema: unknown;
  consumeSema: unknown;
  inputMutex: unknown;
  reverseGameDataShm: SharedMemory | null;
  initStateShm: SharedMemory | null;
}

/**
 * Close/terminate/dispose every allocated resource in reverse order. Mirrors
 * the original cleanup() teardown sequence exactly; the caller nulls its fields
 * afterward.
 */
export function disposeFxResources(
  res: FxDkResources,
  log: (level: "info" | "warn" | "error", message: string) => void,
): void {
  // Close LauncherTalk
  if (res.launcherTalk) {
    try {
      res.launcherTalk.close();
    } catch {
      // Best-effort
    }
  }

  // Terminate and close process handles
  if (res.processManager && res.processHandle) {
    try {
      if (res.processManager.isRunning(res.processHandle)) {
        log("info", `Terminating game process (PID ${res.processHandle.pid})`);
        res.processManager.terminate(res.processHandle);
      }
      res.processManager.close(res.processHandle);
    } catch {
      // Best-effort
    }
  }
  if (res.processManager) {
    res.processManager.dispose();
  }

  // Close semaphores + mutex
  if (res.produceSema) {
    closeSemaphore(res.produceSema);
  }
  if (res.consumeSema) {
    closeSemaphore(res.consumeSema);
  }
  if (res.inputMutex) {
    closeSemaphore(res.inputMutex); // closeSemaphore calls CloseHandle — works for any HANDLE
  }

  // Close shared memory
  if (res.reverseGameDataShm) {
    try {
      res.reverseGameDataShm.close();
    } catch {
      // Best-effort
    }
  }
  if (res.initStateShm) {
    try {
      res.initStateShm.close();
    } catch {
      // Best-effort
    }
  }
}

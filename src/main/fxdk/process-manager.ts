/**
 * FiveM Process Spawning via Koffi — replicates FxDK's SDKGameProcessManager.
 *
 * Launches the FiveM game client as a child process using Win32 CreateProcessW
 * with flags that Node's `child_process` cannot provide:
 *
 * - `CREATE_SUSPENDED` — start the process paused, then resume after setup
 * - `CREATE_UNICODE_ENVIRONMENT` — pass a custom Unicode environment block
 * - Automatic `CitizenFX_SDK_Guest=1` injection into the environment
 *
 * @example
 * ```ts
 * const pm = new FiveMProcessManager()
 * const handle = pm.launch('C:/FiveM/FiveM.exe', ['+connect', 'localhost:30120'], {
 *   suspended: true,
 *   env: { CitizenFX_ToolMode: '1' }
 * })
 * // ... set up shared memory, pipes, etc. ...
 * pm.resume(handle)
 * const exitCode = pm.waitForExit(handle, 30000)
 * pm.close(handle)
 * ```
 */

import koffi from "koffi";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Opaque handle to a launched process, wrapping Win32 PROCESS_INFORMATION. */
export interface ProcessHandle {
  /** Win32 HANDLE to the process object (koffi opaque pointer). */
  hProcess: unknown;
  /** Win32 HANDLE to the primary thread (koffi opaque pointer). */
  hThread: unknown;
  /** Process ID (PID). */
  pid: number;
  /** Primary thread ID (TID). */
  tid: number;
}

/** Options for launching a FiveM process. */
export interface LaunchOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /**
   * Additional environment variables to set in the CURRENT process
   * before CreateProcess (matching FxDK's pattern). These are set,
   * then CreateProcess inherits them, then they are cleared.
   * `CitizenFX_SDK_Guest=1` is always injected.
   */
  env?: Record<string, string>;
  /** If true, the process starts suspended (must call `resume()` manually). */
  suspended?: boolean;
  /**
   * Opaque koffi HANDLE pointers to inherit into the child process
   * via PROC_THREAD_ATTRIBUTE_HANDLE_LIST.
   */
  handleList?: unknown[];
}

// ---------------------------------------------------------------------------
// Win32 constants
// ---------------------------------------------------------------------------

/** Start the process in a suspended state. */
const CREATE_SUSPENDED = 0x00000004;

/** Use STARTUPINFOEX with lpAttributeList. */
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;

/** STILL_ACTIVE exit code — process has not yet terminated. */
const STILL_ACTIVE = 259;

/** WaitForSingleObject: the wait succeeded. */
const WAIT_OBJECT_0 = 0x00000000;

/** WaitForSingleObject: the wait timed out. */
const WAIT_TIMEOUT = 0x00000102;

// ---------------------------------------------------------------------------
// Win32 structs
// ---------------------------------------------------------------------------

const STARTUPINFOW = koffi.struct("STARTUPINFOW", {
  cb: "uint32",
  lpReserved: "void *",
  lpDesktop: "void *",
  lpTitle: "void *",
  dwX: "uint32",
  dwY: "uint32",
  dwXSize: "uint32",
  dwYSize: "uint32",
  dwXCountChars: "uint32",
  dwYCountChars: "uint32",
  dwFillAttribute: "uint32",
  dwFlags: "uint32",
  wShowWindow: "uint16",
  cbReserved2: "uint16",
  lpReserved2: "void *",
  hStdInput: "void *",
  hStdOutput: "void *",
  hStdError: "void *",
});

// STARTUPINFOEXW = STARTUPINFOW + lpAttributeList pointer
void koffi.struct("STARTUPINFOEXW", {
  StartupInfo: STARTUPINFOW,
  lpAttributeList: "void *",
});

// Registered in koffi's type system; referenced by name in CreateProcessW FFI signature string.
void koffi.struct("PROCESS_INFORMATION", {
  hProcess: "void *",
  hThread: "void *",
  dwProcessId: "uint32",
  dwThreadId: "uint32",
});

// ---------------------------------------------------------------------------
// Win32 FFI bindings (lazy-loaded)
// ---------------------------------------------------------------------------

/** PROC_THREAD_ATTRIBUTE_HANDLE_LIST attribute ID */
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;

interface ProcessApi {
  CreateProcessW: (
    lpApplicationName: string | null,
    lpCommandLine: string,
    lpProcessAttributes: null,
    lpThreadAttributes: null,
    bInheritHandles: number,
    dwCreationFlags: number,
    lpEnvironment: Buffer | null,
    lpCurrentDirectory: string | null,
    lpStartupInfo: Record<string, unknown>,
    lpProcessInformation: Record<string, unknown>,
  ) => number;
  ResumeThread: (hThread: unknown) => number;
  TerminateProcess: (hProcess: unknown, uExitCode: number) => number;
  WaitForSingleObject: (hHandle: unknown, dwMs: number) => number;
  GetExitCodeProcess: (hProcess: unknown, lpExitCode: number[]) => number;
  CloseHandle: (hObject: unknown) => number;
  GetLastError: () => number;
  SetEnvironmentVariableW: (lpName: string, lpValue: string | null) => number;
  InitializeProcThreadAttributeList: (
    lpAttributeList: Buffer | null,
    dwAttributeCount: number,
    dwFlags: number,
    lpSize: Buffer,
  ) => number;
  UpdateProcThreadAttribute: (
    lpAttributeList: Buffer,
    dwFlags: number,
    attribute: number,
    lpValue: Buffer,
    cbSize: number,
    lpPrevValue: null,
    lpReturnSize: null,
  ) => number;
  DeleteProcThreadAttributeList: (lpAttributeList: Buffer) => void;
}

let _kernel32: ReturnType<typeof koffi.load> | null = null;
let _api: ProcessApi | null = null;

function api(): ProcessApi {
  if (!_api) {
    if (!_kernel32) {
      _kernel32 = koffi.load("kernel32.dll");
    }
    const k = _kernel32;
    _api = {
      CreateProcessW: k.func(
        "int32 __stdcall CreateProcessW(str16, str16, void*, void*, int32, uint32, void*, str16, _Inout_ STARTUPINFOEXW*, _Out_ PROCESS_INFORMATION*)",
      ),
      ResumeThread: k.func("uint32 __stdcall ResumeThread(void*)"),
      TerminateProcess: k.func("int32 __stdcall TerminateProcess(void*, uint32)"),
      WaitForSingleObject: k.func("uint32 __stdcall WaitForSingleObject(void*, uint32)"),
      GetExitCodeProcess: k.func("int32 __stdcall GetExitCodeProcess(void*, _Out_ uint32*)"),
      CloseHandle: k.func("int32 __stdcall CloseHandle(void*)"),
      GetLastError: k.func("uint32 __stdcall GetLastError()"),
      SetEnvironmentVariableW: k.func("int32 __stdcall SetEnvironmentVariableW(str16, str16)"),
      InitializeProcThreadAttributeList: k.func(
        "int32 __stdcall InitializeProcThreadAttributeList(void*, uint32, uint32, _Inout_ uintptr_t*)",
      ),
      UpdateProcThreadAttribute: k.func(
        "int32 __stdcall UpdateProcThreadAttribute(void*, uint32, uintptr_t, void*, uintptr_t, void*, void*)",
      ),
      DeleteProcThreadAttributeList: k.func("void __stdcall DeleteProcThreadAttributeList(void*)"),
    };
  }
  return _api;
}

// ---------------------------------------------------------------------------
// STARTUPINFOEXW manual buffer layout (x64)
// ---------------------------------------------------------------------------

// (STARTUPINFOEXW is defined as a koffi struct above)

// ---------------------------------------------------------------------------
// FiveMProcessManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of FiveM game processes using Win32 CreateProcessW.
 *
 * Provides capabilities that Node's `child_process` cannot:
 * - CREATE_SUSPENDED for pre-launch setup (shared memory, pipes)
 * - Custom Unicode environment block with CitizenFX_SDK_Guest injection
 * - Direct access to Win32 process and thread HANDLEs
 */
export class FiveMProcessManager {
  /** Track active handles for cleanup on dispose. */
  private readonly activeHandles = new Set<ProcessHandle>();

  /**
   * Launch a FiveM process with Win32 CreateProcessW.
   *
   * @param exePath - Absolute path to the FiveM executable.
   * @param args    - Command-line arguments (e.g. ['+connect', 'localhost:30120']).
   * @param options - Launch configuration.
   * @returns A ProcessHandle for managing the launched process.
   * @throws {Error} If CreateProcessW fails.
   */
  launch(exePath: string, args: string[] = [], options: LaunchOptions = {}): ProcessHandle {
    const w = api();

    // Build command line: quote the exe path, append args
    const cmdLine = [`"${exePath}"`, ...args].join(" ");

    // Set environment variables in current process (FxDK pattern: set before
    // CreateProcess, inherit via lpEnvironment=NULL, clear after)
    const envToSet: Record<string, string> = {
      ...options.env,
      CitizenFX_SDK_Guest: "1",
    };
    for (const [key, value] of Object.entries(envToSet)) {
      w.SetEnvironmentVariableW(key, value);
    }

    // Assemble creation flags
    let flags = 0;
    if (options.suspended) {
      flags |= CREATE_SUSPENDED;
    }

    // Build PROC_THREAD_ATTRIBUTE_LIST if handles need to be inherited
    let attListBuf: Buffer | null = null;
    let handleBuf: Buffer | null = null;

    const hasHandleList = options.handleList && options.handleList.length > 0;
    if (hasHandleList) {
      flags |= EXTENDED_STARTUPINFO_PRESENT;

      // Step 1: query required size
      const sizeBuf = Buffer.alloc(8);
      // First call with null to get required size (returns 0, sets sizeBuf)
      w.InitializeProcThreadAttributeList(null, 1, 0, sizeBuf);
      const requiredSize = Number(sizeBuf.readBigUInt64LE(0));

      // Step 2: allocate and initialize
      attListBuf = Buffer.alloc(requiredSize);
      const initOk = w.InitializeProcThreadAttributeList(attListBuf, 1, 0, sizeBuf);
      if (!initOk) {
        throw new Error(
          `InitializeProcThreadAttributeList failed (GetLastError=${w.GetLastError()})`,
        );
      }

      // Step 3: build array of HANDLE values (8 bytes each on x64)
      const handles = options.handleList!;
      handleBuf = Buffer.alloc(handles.length * 8);
      for (let i = 0; i < handles.length; i++) {
        const addr = koffi.address(handles[i]);
        handleBuf.writeBigUInt64LE(addr, i * 8);
      }

      // Step 4: update attribute
      const updateOk = w.UpdateProcThreadAttribute(
        attListBuf,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handleBuf,
        handleBuf.length,
        null,
        null,
      );
      if (!updateOk) {
        throw new Error(`UpdateProcThreadAttribute failed (GetLastError=${w.GetLastError()})`);
      }
    }

    // Build STARTUPINFOEXW — koffi encodes nested struct + pointer fields
    const si: Record<string, unknown> = {
      StartupInfo: {
        cb: hasHandleList
          ? koffi.sizeof(STARTUPINFOW) + 8 // sizeof(STARTUPINFOEXW)
          : koffi.sizeof(STARTUPINFOW),
        lpReserved: null,
        lpDesktop: null,
        lpTitle: null,
        dwX: 0,
        dwY: 0,
        dwXSize: 0,
        dwYSize: 0,
        dwXCountChars: 0,
        dwYCountChars: 0,
        dwFillAttribute: 0,
        dwFlags: 0,
        wShowWindow: 0,
        cbReserved2: 0,
        lpReserved2: null,
        hStdInput: null,
        hStdOutput: null,
        hStdError: null,
      },
      lpAttributeList: attListBuf ?? null,
    };

    const pi: Record<string, unknown> = {};

    const success = w.CreateProcessW(
      exePath, // lpApplicationName
      cmdLine,
      null, // lpProcessAttributes
      null, // lpThreadAttributes
      hasHandleList ? 1 : 0, // bInheritHandles
      flags,
      null, // lpEnvironment — inherit from current process
      options.cwd ?? null,
      si,
      pi,
    );

    // Clean up: clear environment variables we set
    for (const key of Object.keys(envToSet)) {
      w.SetEnvironmentVariableW(key, null);
    }

    // Clean up attribute list
    if (attListBuf) {
      w.DeleteProcThreadAttributeList(attListBuf);
    }

    if (!success) {
      throw new Error(`CreateProcessW failed for "${exePath}" (GetLastError=${w.GetLastError()})`);
    }

    const handle: ProcessHandle = {
      hProcess: pi.hProcess,
      hThread: pi.hThread,
      pid: pi.dwProcessId as number,
      tid: pi.dwThreadId as number,
    };

    this.activeHandles.add(handle);
    return handle;
  }

  /**
   * Resume the primary thread of a suspended process.
   *
   * @param handle - The ProcessHandle returned by `launch()`.
   * @returns The previous suspend count (1 means the thread is now running).
   * @throws {Error} If ResumeThread fails.
   */
  resume(handle: ProcessHandle): number {
    const prevCount = api().ResumeThread(handle.hThread);
    if (prevCount === 0xffffffff) {
      throw new Error(
        `ResumeThread failed for PID ${handle.pid} (GetLastError=${api().GetLastError()})`,
      );
    }
    return prevCount;
  }

  /**
   * Forcefully terminate the process.
   *
   * @param handle   - The ProcessHandle returned by `launch()`.
   * @param exitCode - Exit code to set on the terminated process (default: 1).
   * @throws {Error} If TerminateProcess fails.
   */
  terminate(handle: ProcessHandle, exitCode = 1): void {
    const result = api().TerminateProcess(handle.hProcess, exitCode);
    if (!result) {
      throw new Error(
        `TerminateProcess failed for PID ${handle.pid} (GetLastError=${api().GetLastError()})`,
      );
    }
  }

  /**
   * Wait for the process to exit and return its exit code.
   *
   * @param handle  - The ProcessHandle returned by `launch()`.
   * @param timeout - Maximum wait in milliseconds (default: INFINITE / 0xFFFFFFFF).
   * @returns The process exit code, or -1 if the wait timed out.
   */
  waitForExit(handle: ProcessHandle, timeout = 0xffffffff): number {
    const w = api();
    const waitResult = w.WaitForSingleObject(handle.hProcess, timeout);

    if (waitResult === WAIT_TIMEOUT) {
      return -1;
    }

    if (waitResult !== WAIT_OBJECT_0) {
      throw new Error(
        `WaitForSingleObject failed for PID ${handle.pid} (result=${waitResult}, GetLastError=${w.GetLastError()})`,
      );
    }

    const exitCode: number[] = [0];
    w.GetExitCodeProcess(handle.hProcess, exitCode);
    return exitCode[0];
  }

  /**
   * Check whether the process is still running.
   *
   * @param handle - The ProcessHandle returned by `launch()`.
   * @returns `true` if the process is still alive.
   */
  isRunning(handle: ProcessHandle): boolean {
    const w = api();
    const exitCode: number[] = [0];
    const success = w.GetExitCodeProcess(handle.hProcess, exitCode);
    if (!success) return false;
    return exitCode[0] === STILL_ACTIVE;
  }

  /**
   * Close the Win32 handles associated with a process.
   *
   * This does NOT terminate the process — it only releases our handles.
   * Always call this after the process has exited or been terminated
   * to prevent handle leaks.
   *
   * @param handle - The ProcessHandle returned by `launch()`.
   */
  close(handle: ProcessHandle): void {
    const w = api();
    if (handle.hThread) {
      w.CloseHandle(handle.hThread);
    }
    if (handle.hProcess) {
      w.CloseHandle(handle.hProcess);
    }
    this.activeHandles.delete(handle);
  }

  /**
   * Terminate and close all tracked processes.
   * Call this during application shutdown to prevent handle leaks.
   */
  dispose(): void {
    for (const handle of this.activeHandles) {
      try {
        if (this.isRunning(handle)) {
          this.terminate(handle);
        }
      } catch {
        // Best-effort cleanup — process may have already exited.
      }
      try {
        this.close(handle);
      } catch {
        // Ignore double-close errors.
      }
    }
    this.activeHandles.clear();
  }
}

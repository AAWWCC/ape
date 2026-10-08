import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Execution context, not authentication. Gate HMACs and process witnesses are
// still required. Nothing from callers, environment, hostname or project files
// participates in this identity. A successful value lives only as long as this
// process (which cannot survive a reboot or change its own PID namespace).
const PREFIX = 'ape-execution-v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let cached;
const windowsBootScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ApeBootIdentity {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int c, IntPtr p, int n, out int size);
  public static string Read() {
    IntPtr p = Marshal.AllocHGlobal(32);
    try {
      int size;
      if (NtQuerySystemInformation(90, p, 32, out size) != 0) throw new Exception("Boot identity unavailable");
      byte[] bytes = new byte[16]; Marshal.Copy(p, bytes, 0, 16);
      return new Guid(bytes).ToString();
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@
[ApeBootIdentity]::Read()
`;

export function localExecutionIdentity() {
  if (cached) return cached;
  try {
    let boot;
    let namespace = '';
    const options = { encoding: /** @type {const} */ ('utf8'), timeout: 5_000, maxBuffer: 16_384, windowsHide: true };
    if (process.platform === 'linux') {
      boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      namespace = readlinkSync('/proc/self/ns/pid');
      if (!/^pid:\[[1-9][0-9]*\]$/.test(namespace)) throw new Error('invalid namespace');
    } else if (process.platform === 'darwin') {
      boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], options).trim();
    } else if (process.platform === 'win32') {
      // Deliberately do not honor SystemRoot/PATH overrides. Nonstandard system
      // installations fail closed instead of selecting a caller's executable.
      boot = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsBootScript], {
          ...options,
          // Add-Type is a system module. Inheriting PSModulePath, PATH or CLR
          // configuration would let the caller replace the evidence provider.
          env: {
            SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
            PATH: 'C:\\Windows\\System32',
            PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
            TEMP: 'C:\\Windows\\Temp', TMP: 'C:\\Windows\\Temp',
          },
        }).trim();
    } else {
      throw new Error('unsupported platform');
    }
    if (!UUID.test(boot) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(boot)) throw new Error('invalid boot identity');
    cached = PREFIX + createHash('sha256').update(JSON.stringify([process.platform, boot.toLowerCase(), namespace])).digest('hex');
    return cached;
  } catch {
    throw new Error('local execution identity unavailable: cannot verify OS boot/namespace evidence; ownership is retained');
  }
}

export function executionIdentityProblem(value) {
  let local;
  try { local = localExecutionIdentity(); } catch { return 'unavailable'; }
  if (typeof value !== 'string' || !/^ape-execution-v1:[a-f0-9]{64}$/.test(value)) return 'legacy-or-malformed';
  return value === local ? null : 'foreign-execution';
}

export function isLocalExecution(value) {
  return executionIdentityProblem(value) === null;
}

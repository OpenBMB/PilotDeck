param([int]$GuardianPid, [string]$ReadyFile, [string]$StoppedFile, [string]$StopFile, [string]$GuardianBirth)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class PilotDeckJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic; public IO Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long A,B,C,D; public uint Faults, Total, Active, Terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting value, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool success) { if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Run(int pid, string ready, string stopped, string stop, string birth) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null), process = IntPtr.Zero;
    if (job == IntPtr.Zero) Check(false);
    try {
      var limits = new Limits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))));
      process = OpenProcess(0x101101, false, pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION | SET_QUOTA | TERMINATE
      if (process == IntPtr.Zero) Check(false);
      long creation, exit, kernel, user;
      Check(GetProcessTimes(process, out creation, out exit, out kernel, out user));
      long expected = DateTime.Parse(birth, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime().ToFileTimeUtc();
      // CIM creation timestamps have microsecond precision. Validate the opened
      // handle before assigning it: the bootstrap PID might already be reused.
      if (creation / 10 != expected / 10) throw new Exception("Guardian process identity changed");
      Check(AssignProcessToJobObject(job, process));
      File.WriteAllText(ready, "ready"); // The guardian cannot launch the command before this.
      while (true) {
        uint state = WaitForSingleObject(process, 25);
        if (state == 0 || File.Exists(stop)) break;
        if (state != 258) throw new Exception("Guardian wait failed");
      }
      Check(TerminateJobObject(job, 1));
      var deadline = DateTime.UtcNow.AddSeconds(5);
      while (true) {
        Accounting state;
        Check(QueryInformationJobObject(job, 1, out state, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (state.Active == 0) break;
        if (DateTime.UtcNow >= deadline) throw new Exception("Job still has active processes");
        Thread.Sleep(25);
      }
      File.WriteAllText(stopped, "stopped");
    } finally { if (process != IntPtr.Zero) CloseHandle(process); CloseHandle(job); }
  }
}
'@
[PilotDeckJob]::Run($GuardianPid, $ReadyFile, $StoppedFile, $StopFile, $GuardianBirth)

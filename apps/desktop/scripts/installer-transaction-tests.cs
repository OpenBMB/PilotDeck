using System;
using System.IO;
using System.Threading;

internal static class InstallerTests
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }

    static int Main(string[] args)
    {
        string root = args[0];
        string payload = Path.Combine(root, "payload"), target = Path.Combine(root, "target"), backup = Path.Combine(root, "backup");
        Directory.CreateDirectory(payload);
        Directory.CreateDirectory(target);
        Directory.CreateDirectory(Path.Combine(payload, "resources"));
        Directory.CreateDirectory(Path.Combine(target, "resources"));
        File.WriteAllText(Path.Combine(payload, "resources", "new.txt"), "new component");
        File.WriteAllText(Path.Combine(target, "resources", "old.txt"), "old component");
        File.WriteAllText(Path.Combine(payload, "app.exe"), "new executable");
        File.WriteAllText(Path.Combine(target, "app.exe"), "old executable");
        File.WriteAllText(Path.Combine(target, "unrelated.txt"), "leave alone");
        bool failed = false;
        try { InstallPayload.Commit(payload, target, backup, count => { if (count == 2) throw new IOException("injected commit failure"); }); }
        catch (IOException) { failed = true; }
        Check(failed, "commit error must propagate");
        Check(File.ReadAllText(Path.Combine(target, "app.exe")) == "old executable", "restore overwritten executable");
        Check(File.Exists(Path.Combine(target, "resources", "old.txt")), "restore resource directory");
        Check(!File.Exists(Path.Combine(target, "resources", "new.txt")), "remove partially committed resources");
        Check(File.Exists(Path.Combine(payload, "resources", "new.txt")), "keep new files available for retry");
        InstallPayload.Commit(payload, target, backup, null);
        Check(File.ReadAllText(Path.Combine(target, "app.exe")) == "new executable", "retry installs executable");
        Check(File.Exists(Path.Combine(target, "resources", "new.txt")), "retry installs every component");
        Check(File.Exists(Path.Combine(target, "unrelated.txt")), "preserve unrelated entries");
        Check(Directory.GetFileSystemEntries(payload).Length == 0, "commit moves files instead of copying them");
        Check(File.Exists(Path.Combine(backup, "resources", "old.txt")), "retain replaced resources until commit succeeds");
        string lockedPayload = Path.Combine(root, "locked-payload"), lockedBackup = Path.Combine(root, "locked-backup");
        Directory.CreateDirectory(lockedPayload);
        File.WriteAllText(Path.Combine(lockedPayload, "app.exe"), "after transient lock");
        using (var heldFile = File.Open(Path.Combine(target, "app.exe"), FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var release = new Timer(_ => heldFile.Dispose(), null, 600, Timeout.Infinite))
            InstallPayload.Commit(lockedPayload, target, lockedBackup, null);
        Check(File.ReadAllText(Path.Combine(target, "app.exe")) == "after transient lock", "retry after a real Windows sharing violation");
        Check(InstallPayload.RemainingSeconds(2, 30, 0) == null, "do not estimate without a sufficient sample");
        Check(InstallPayload.RemainingSeconds(10, 50, 0) == 10, "estimate from actual progress");
        Check(InstallPayload.RemainingSeconds(30, 50, 10) == null, "hide a stale estimate");
        Check(InstallPayload.RemainingSeconds(10, 100, 0) == null, "do not report zero while finalizing");
        Check(InstallPayload.RemainingSeconds(10, 99, 0) == 5, "round up small estimates");
        Check(InstallPayload.RemainingSeconds(100000, 1, 0) == 86395, "bound estimates without wrapping to zero hours");
        Console.WriteLine("PASS: commit, rollback, retry, transient file locks, component preservation and ETA edge cases");
        return 0;
    }
}

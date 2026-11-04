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
        string workspace = Path.Combine(root, "user workspace"), protectedPayload = Path.Combine(root, "protected-payload");
        Directory.CreateDirectory(Path.Combine(workspace, "resources"));
        Directory.CreateDirectory(Path.Combine(protectedPayload, "resources"));
        File.WriteAllText(Path.Combine(workspace, ".pilotdeck-workspace"), "workspace identity");
        File.WriteAllText(Path.Combine(workspace, "resources", "report.txt"), "user data");
        File.WriteAllText(Path.Combine(protectedPayload, "resources", "new.txt"), "new application");
        foreach (string destination in new[] { workspace, Path.Combine(workspace, "nested-install") })
        {
            bool rejected = false;
            try { InstallPayload.Commit(protectedPayload, destination, Path.Combine(root, "must-not-backup"), null); }
            catch (IOException) { rejected = true; }
            Check(rejected, "refuse installing in or below a registered workspace");
            Check(File.ReadAllText(Path.Combine(workspace, "resources", "report.txt")) == "user data", "preserve user files before replacing resources");
            Check(File.Exists(Path.Combine(protectedPayload, "resources", "new.txt")), "do not consume payload on rejection");
        }
        string nestedTarget = Path.Combine(root, "nested-target");
        string nestedWorkspace = Path.Combine(nestedTarget, "resources", "user-workspace");
        Directory.CreateDirectory(nestedWorkspace);
        File.WriteAllText(Path.Combine(nestedWorkspace, ".pilotdeck-workspace"), "workspace identity");
        File.WriteAllText(Path.Combine(nestedWorkspace, "report.txt"), "irreplaceable user data");
        File.WriteAllText(Path.Combine(nestedTarget, "app.exe"), "old executable");
        bool nestedRejected = false;
        try { InstallPayload.Commit(protectedPayload, nestedTarget, Path.Combine(root, "must-not-backup"), null); }
        catch (IOException) { nestedRejected = true; }
        Check(nestedRejected, "refuse replacing a subtree containing a workspace");
        Check(File.ReadAllText(Path.Combine(nestedWorkspace, "report.txt")) == "irreplaceable user data", "preserve nested workspace bytes");
        Check(File.ReadAllText(Path.Combine(nestedTarget, "app.exe")) == "old executable", "preflight before moving any application files");
        Check(!Directory.Exists(Path.Combine(root, "must-not-backup")), "rejection must not create a backup");
        Check(File.Exists(Path.Combine(protectedPayload, "resources", "new.txt")), "nested rejection must not consume payload");
        Console.WriteLine("PASS: commit, rollback, retry, transient file locks, component preservation and ETA edge cases");
        return 0;
    }
}

// Runs only during NSIS installation, using the .NET Framework included with
// supported Windows versions. Exit zero only after extraction and commit succeed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

internal static class InstallPayload
{
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr parent, int id);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, string text);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);

    static readonly Regex Percent = new Regex(@"(?:^|\s)(\d{1,3})%", RegexOptions.Compiled);
    static readonly object ProgressLock = new object();
    static int progress;
    static IntPtr owner, label, bar;
    static bool chinese;
    static string cancelFile;
    static int displayedProgress = -1;

    static void CheckCancellation()
    {
        if ((cancelFile != null && File.Exists(cancelFile)) || (owner != IntPtr.Zero && !IsWindow(owner)))
            throw new OperationCanceledException();
    }

    static string Text(string en, string zh) { return chinese ? zh : en; }

    internal static int? RemainingSeconds(double elapsed, int percent, double stalledSeconds)
    {
        if (elapsed < 3 || percent < 1 || percent >= 100 || stalledSeconds >= 10) return null;
        // Round up; never promise zero seconds while files are still being written.
        return (int)Math.Min(86395, Math.Max(5, Math.Ceiling(elapsed * (100 - percent) / percent / 5) * 5));
    }

    static void Status(string message, int? percent)
    {
        Console.WriteLine(message);
        if (label == IntPtr.Zero) return;
        SendMessage(label, 0x000C, IntPtr.Zero, message); // WM_SETTEXT
        if (percent.HasValue && percent.Value > displayedProgress)
        {
            displayedProgress = Math.Max(percent.Value, SendMessage(bar, 0x0408, IntPtr.Zero, IntPtr.Zero).ToInt32() / 10);
            // An independent control: NSIS's instruction counter still updates
            // its hidden original bar. Never reset the range/style for a log.
            SendMessage(bar, 0x0402, new IntPtr(displayedProgress * 10), IntPtr.Zero);
        }
    }

    static void Observe(string text)
    {
        Match match = Percent.Match(text);
        int value;
        if (match.Success && int.TryParse(match.Groups[1].Value, out value) && value <= 100)
            lock (ProgressLock) progress = Math.Max(progress, value);
    }

    static void ReadProgress(StreamReader reader)
    {
        var buffer = new StringBuilder();
        int next;
        while ((next = reader.Read()) != -1)
        {
            char c = (char)next;
            if (c == '\r' || c == '\n' || c == '\b') { Observe(buffer.ToString()); buffer.Clear(); }
            else if (buffer.Length < 2048) buffer.Append(c);
        }
        Observe(buffer.ToString());
    }

    static string Quote(string value)
    {
        // All arguments are file paths; reject quotes/control characters instead
        // of feeding them to a shell. Trim trailing separators before quoting.
        if (value.IndexOfAny(new[] { '"', '\r', '\n' }) >= 0) throw new ArgumentException("Invalid path");
        return "\"" + value.TrimEnd('\\', '/') + "\"";
    }

    static void Extract(string decoder, string archive, string destination)
    {
        CheckCancellation();
        progress = 0;
        var start = new ProcessStartInfo(decoder,
            "x -y -bsp1 -bso0 -bse2 -o" + Quote(destination) + " -- " + Quote(archive));
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        Status(Text("Extracting files - estimating remaining time...", "正在解压文件，正在估算剩余时间……"), 0);
        using (var worker = Process.Start(start))
        {
            var output = Task.Run(() => ReadProgress(worker.StandardOutput));
            var errors = worker.StandardError.ReadToEndAsync();
            var clock = Stopwatch.StartNew();
            int last = -1;
            double lastAdvance = 0, lastDisplay = -1;
            try
            {
                while (!worker.WaitForExit(200))
                {
                    CheckCancellation();
                    int percent;
                    lock (ProgressLock) percent = progress;
                    double elapsed = clock.Elapsed.TotalSeconds;
                    if (percent != last) { last = percent; lastAdvance = elapsed; }
                    if (elapsed - lastDisplay < 1) continue;
                    lastDisplay = elapsed;
                    int? eta = RemainingSeconds(elapsed, percent, elapsed - lastAdvance);
                    string remaining = eta.HasValue
                        ? Text("about ", "解压预计剩余：") + TimeSpan.FromSeconds(eta.Value).ToString(@"hh\:mm\:ss") + Text(" remaining", "")
                        : Text("estimating remaining time...", "正在估算剩余时间……");
                    // The percentage describes extraction only, not finalization.
                    Status(Text("Extracting files: ", "正在解压文件：") + Math.Min(percent, 99) + "% - " + remaining, percent * 90 / 100);
                }
                worker.WaitForExit();
                output.GetAwaiter().GetResult();
                string error = errors.GetAwaiter().GetResult();
                if (worker.ExitCode != 0) throw new IOException("7-Zip extraction failed (" + worker.ExitCode + "): " + error);
                CheckCancellation();
                Console.WriteLine("Extraction completed in " + clock.Elapsed.TotalSeconds.ToString("F1", CultureInfo.InvariantCulture) + " s.");
            }
            finally
            {
                if (!worker.HasExited) { worker.Kill(); worker.WaitForExit(); }
            }
        }
    }

    static void RetryFileOperation(Action operation, int timeoutSeconds)
    {
        var clock = Stopwatch.StartNew();
        int delay = 100;
        for (;;)
        {
            try { operation(); return; }
            catch (Exception error)
            {
                // Antivirus/indexers can briefly hold a freshly extracted file.
                // Retry transient filesystem failures, never recursively copy.
                if (!(error is IOException || error is UnauthorizedAccessException) || clock.Elapsed.TotalSeconds >= timeoutSeconds) throw;
                Console.WriteLine(Text("Waiting for files to become available: ", "正在等待文件解除占用：") + error.Message);
                Thread.Sleep(delay);
                delay = Math.Min(1000, delay * 2);
            }
        }
    }

    static void Move(string from, string to)
    {
        RetryFileOperation(() =>
        {
            if (Directory.Exists(from)) Directory.Move(from, to);
            else File.Move(from, to);
        }, 15);
    }

    internal static void Commit(string payload, string target, string backup, Action<int> checkpoint)
    {
        // Only move top-level entries: large resource directories are renamed as
        // a whole. Never fall back to recursive copying or delete user data.
        var saved = new List<string>();
        var installed = new List<string>();
        string[] entries = Directory.GetFileSystemEntries(payload);
        if (entries.Length == 0) throw new IOException("The application payload is empty");
        Directory.CreateDirectory(backup);
        int count = 0;
        try
        {
            foreach (string entry in entries)
            {
                string name = Path.GetFileName(entry), existing = Path.Combine(target, name);
                if (File.Exists(existing) || Directory.Exists(existing))
                {
                    Move(existing, Path.Combine(backup, name));
                    saved.Add(name);
                }
                Move(entry, existing);
                installed.Add(name);
                if (checkpoint != null) checkpoint(++count);
            }
        }
        catch (Exception failure)
        {
            // Keep backups if restoration is blocked, so the user can recover.
            try
            {
                for (int i = installed.Count - 1; i >= 0; i--)
                    Move(Path.Combine(target, installed[i]), Path.Combine(payload, installed[i]));
                for (int i = saved.Count - 1; i >= 0; i--)
                    Move(Path.Combine(backup, saved[i]), Path.Combine(target, saved[i]));
            }
            catch (Exception rollback)
            {
                throw new IOException("Commit and rollback failed. Recovery files: " + backup, new AggregateException(failure, rollback));
            }
            throw;
        }
    }

    static void RejectReparseParents(string target)
    {
        for (var dir = new DirectoryInfo(target); dir != null; dir = dir.Parent)
            if (dir.Exists && (dir.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Installation through a directory junction is not supported: " + dir.FullName);
    }

    static int Main(string[] args)
    {
        string stage = null;
        string stateFile = null;
        bool prepared = false;
        bool committed = false;
        bool commitOnly = false;
        try
        {
            commitOnly = args.Length == 4 && args[0] == "--commit";
            bool discard = args.Length == 2 && args[0] == "--discard";
            bool prepareOnly = args.Length == 6;
            if (!commitOnly && !discard && !prepareOnly && args.Length != 5)
                throw new ArgumentException("Expected payload arguments, --commit state window language, or --discard state");
            string target;
            if (commitOnly || discard)
            {
                stateFile = Path.GetFullPath(args[1]);
                if (discard && !File.Exists(stateFile)) return 0;
                string[] saved = File.ReadAllLines(stateFile);
                if (saved.Length != 2) throw new IOException("Invalid installation state");
                target = Path.GetFullPath(saved[1]);
                string candidate = Path.GetFullPath(saved[0]);
                // Validate before assigning stage: finally must never clean an
                // arbitrary path from a malformed state file.
                if (Path.GetDirectoryName(candidate) != Path.GetDirectoryName(target)
                    || !Regex.IsMatch(Path.GetFileName(candidate), @"^\.pilotdeck-install-[a-f0-9]{32}$"))
                    throw new IOException("Invalid staging directory");
                RejectReparseParents(candidate);
                RejectReparseParents(target);
                stage = candidate;
                if (discard) { File.Delete(stateFile); return 0; }
                owner = new IntPtr(long.Parse(args[2], CultureInfo.InvariantCulture));
                chinese = args[3] == "zh";
            }
            else
            {
                target = Path.GetFullPath(args[2]).TrimEnd('\\', '/');
                owner = new IntPtr(long.Parse(args[3], CultureInfo.InvariantCulture));
                chinese = args[4] == "zh";
                if (prepareOnly)
                {
                    stateFile = Path.GetFullPath(args[5]);
                    cancelFile = stateFile + ".cancel";
                }
            }
            Console.OutputEncoding = Encoding.Default; // nsExec decodes Windows ANSI text
            if (owner != IntPtr.Zero)
            {
                var page = FindWindowEx(owner, IntPtr.Zero, "#32770", null);
                label = GetDlgItem(page, 1006);
                bar = GetDlgItem(page, 1136);
            }
            RejectReparseParents(target);
            string parent = Path.GetDirectoryName(target);
            if (String.IsNullOrEmpty(parent)) throw new IOException("Cannot install at a volume root");
            if (!commitOnly) stage = Path.Combine(parent, ".pilotdeck-install-" + Guid.NewGuid().ToString("N"));
            string payload = Path.Combine(stage, "payload"), backup = Path.Combine(stage, "backup");
            if (!commitOnly)
            {
                Directory.CreateDirectory(payload);
                Console.WriteLine("Staging on the destination volume: " + stage);
                Extract(Path.GetFullPath(args[0]), Path.GetFullPath(args[1]), payload);
                if (prepareOnly)
                {
                    File.WriteAllLines(stateFile, new[] { stage, target });
                    prepared = true;
                    Status(Text("Files ready for installation.", "文件准备完成。"), 90);
                    return 0;
                }
            }
            Status(Text("Committing installation files...", "正在提交安装文件……"), 90);
            Directory.CreateDirectory(target);
            Commit(payload, target, backup, null);
            committed = true;
            if (stateFile != null) File.Delete(stateFile);
            Status(Text("Finalizing installation: update cache and shortcuts...", "正在完成安装：更新缓存和快捷方式……"), 95);
            return 0;
        }
        catch (OperationCanceledException)
        {
            Status(Text("Installation cancelled. Existing installation has not been changed.", "安装已取消，原有安装未被更改。"), null);
            return 1223; // ERROR_CANCELLED
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            // An update has already removed the old installation by this
            // point. Keep the extracted files and the exact failure for repair.
            if (commitOnly && stage != null)
            {
                try { File.WriteAllText(Path.Combine(stage, "install-error.log"), error.ToString()); }
                catch { /* Keep the primary installation error. */ }
            }
            Status(Text("Installation failed. See details below.", "安装失败，请查看下方详情。"), null);
            return 1;
        }
        finally
        {
            // stage is always our newly created, fixed-prefix directory. Never
            // recursively delete target or externally provided paths.
            try
            {
                if (!prepared && !(commitOnly && !committed) && stage != null && Directory.Exists(stage))
                {
                    string backup = Path.Combine(stage, "backup");
                    bool hasRecovery = !committed && Directory.Exists(backup) && Directory.GetFileSystemEntries(backup).Length != 0;
                    if (!hasRecovery) RetryFileOperation(() => { if (Directory.Exists(stage)) Directory.Delete(stage, true); }, 5);
                }
            }
            catch (Exception error) { Console.WriteLine("Temporary files retained at " + stage + ": " + error.Message); }
        }
    }
}

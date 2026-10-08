// Drives only the isolated installer process passed by verify-installer-e2e.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
class InstallerUiTests
{
    delegate bool EnumCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowStyle(IntPtr window, int index);
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr parent, int id);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    static string Text(IntPtr window)
    {
        var text = new StringBuilder(4096);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static bool IsCheckbox(IntPtr window)
    {
        var name = new StringBuilder(64);
        GetClassName(window, name, name.Capacity);
        int kind = GetWindowStyle(window, -16) & 15;
        return IsWindowVisible(window) && name.ToString() == "Button" && (kind == 2 || kind == 3);
    }
    static void Click(IntPtr window) { PostMessage(window, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        string mode = args[2];
        string installerArgs = mode == "approve-updated" ? "--updated /currentuser" : "/currentuser /D=" + args[1];
        using (var process = Process.Start(new ProcessStartInfo(args[0], installerArgs) { UseShellExecute = false }))
        {
            try
            {
                bool prompted = false, cancelSent = false, cancelConfirmed = false, sawProgress = false, openedDetails = false, sawRunOption = false;
                int last = 0, advances = 0;
                var timer = Stopwatch.StartNew();
                long nextClick = 0;
                string lastWindowText = "";
                while (!process.HasExited && timer.Elapsed.TotalSeconds < 50)
                {
                    var windows = new List<IntPtr>();
                    EnumWindows((window, data) => {
                        uint pid; GetWindowThreadProcessId(window, out pid);
                        if (pid == process.Id && IsWindowVisible(window)) windows.Add(window);
                        return true;
                    }, IntPtr.Zero);
                    foreach (var window in windows)
                    {
                        var children = new List<IntPtr>();
                        EnumChildWindows(window, (child, data) => { children.Add(child); return true; }, IntPtr.Zero);
                        string text = String.Join("\n", children.ConvertAll(child => Text(child)));
                        lastWindowText = text;
                        if (text.Contains("existing version was found") || text.Contains("检测到已安装版本")
                            || text.Contains("selected directory differs") || text.Contains("所选目录与旧版安装目录"))
                        {
                            if (!prompted)
                            {
                                Check(mode.StartsWith("move-"), "Same-directory upgrade must not ask about uninstall/overwrite");
                                Check((SendMessage(window, 0x0400, IntPtr.Zero, IntPtr.Zero).ToInt32() & 65535) == 7, "Moving must default to keeping the existing installation");
                                prompted = true;
                                Click(GetDlgItem(window, mode == "move-approve" ? 6 : 7));
                            }
                            continue;
                        }
                        if (text.Contains("Cancel installation?") || text.Contains("是否取消安装"))
                        {
                            if (!cancelConfirmed)
                            {
                                // Keep the modal open past extraction completion: commit must wait.
                                if (mode == "cancel") Thread.Sleep(6500);
                                cancelConfirmed = true;
                                Click(GetDlgItem(window, 6));
                            }
                            continue;
                        }
                        bool onInstallPage = false;
                        foreach (var child in children)
                        {
                            IntPtr bar = GetDlgItem(child, 1136);
                            if (bar == IntPtr.Zero || !IsWindowVisible(bar)) continue;
                            var className = new StringBuilder(256);
                            GetClassName(bar, className, className.Capacity);
                            if (className.ToString() != "msctls_progress32") continue;
                            onInstallPage = true;
                            sawProgress = true;
                            int position = SendMessage(bar, 0x0408, IntPtr.Zero, IntPtr.Zero).ToInt32();
                            if (!IsWindowVisible(bar)) continue; // finish page may replace it mid-poll
                            Check(position >= last, "Progress regressed from " + last + " to " + position);
                            if (position > last) advances++;
                            last = position;
                            if (!openedDetails && position > 0)
                            {
                                Click(GetDlgItem(child, 1027));
                                openedDetails = true;
                            }
                            if (mode.StartsWith("cancel") && position >= 100 && !cancelSent)
                            {
                                var cancel = GetDlgItem(window, 2);
                                Check(IsWindowEnabled(cancel), "Cancel button disabled during extraction");
                                cancelSent = true;
                                Click(cancel);
                            }
                        }
                        var next = GetDlgItem(window, 1);
                        // MUI advances automatically when extraction finishes. A
                        // queued click from that page can close the finish page
                        // before we have inspected its run checkbox.
                        if (!onInstallPage && IsWindowEnabled(next) && timer.ElapsedMilliseconds >= nextClick)
                        {
                            // Uncheck the finish-page 'run' option (fixture app is data).
                            foreach (var child in children)
                                if (IsCheckbox(child))
                                {
                                    sawRunOption = true;
                                    SendMessage(child, 0x00F1, IntPtr.Zero, IntPtr.Zero);
                                }
                            Click(next);
                            nextClick = timer.ElapsedMilliseconds + 250;
                        }
                    }
                    Thread.Sleep(15);
                }
                Check(process.HasExited, "Installer UI timed out: " + lastWindowText);
                Check(prompted == mode.StartsWith("move-"), "Only moving installation should require confirmation");
                if (mode.StartsWith("cancel")) Check(cancelSent && cancelConfirmed && advances >= 2, "Cancellation/progress path not exercised");
                if (mode.StartsWith("approve") || mode == "overwrite" || mode == "move-approve") Check(sawProgress && advances >= 3 && last >= 900, "Cumulative progress not exercised");
                if (mode == "approve-updated") Check(sawRunOption, "Visible update must offer to start the installed app: " + lastWindowText);
                Check(process.ExitCode == (mode.StartsWith("approve") || mode == "overwrite" || mode == "move-approve" ? 0 : 1223), "Unexpected exit " + process.ExitCode);
                Console.WriteLine("PASS: interactive " + mode + ", progress changes=" + advances + ", final=" + last);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                if (!process.HasExited) process.Kill();
                return 1;
            }
        }
    }
}

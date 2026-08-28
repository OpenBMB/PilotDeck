[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$code = @"
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class PilotDeckExplorerFolderDialog
{
    private const int ASFW_ANY = -1;
    private const uint GA_ROOT = 2;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int dwProcessId);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    public static string PickFolder()
    {
        IntPtr ownerHwnd = GetTopLevelWindow(GetForegroundWindow());
        AllowSetForegroundWindow(ASFW_ANY);

        var ofd = new OpenFileDialog();
        ofd.AddExtension = false;
        ofd.CheckFileExists = false;
        ofd.CheckPathExists = true;
        ofd.DereferenceLinks = true;
        ofd.Filter = "Folders|\n";
        ofd.Multiselect = false;
        ofd.Title = "Select Folder";
        ofd.ValidateNames = false;
        ofd.FileName = "Select Folder";

        uint unusedPid;
        uint ownerThread = ownerHwnd == IntPtr.Zero ? 0 : GetWindowThreadProcessId(ownerHwnd, out unusedPid);
        uint ourThread = GetCurrentThreadId();
        bool attached = ownerThread != 0 && ownerThread != ourThread && AttachThreadInput(ourThread, ownerThread, true);

        using (var fallbackOwner = ownerHwnd == IntPtr.Zero ? CreateOwnerWindow() : null)
        {
            IntPtr dialogOwner = ownerHwnd != IntPtr.Zero ? ownerHwnd : fallbackOwner.Handle;
            StartRaiseDialogWindow();
            var assembly = typeof(FileDialog).Assembly;
            var iFileDialogType = assembly.GetType("System.Windows.Forms.FileDialogNative+IFileDialog");
            var fosType = assembly.GetType("System.Windows.Forms.FileDialogNative+FOS");
            var eventsType = assembly.GetType("System.Windows.Forms.FileDialog+VistaDialogEvents");
            if (iFileDialogType == null || fosType == null || eventsType == null)
            {
                throw new InvalidOperationException("Vista folder dialog types are unavailable.");
            }

            var flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            var createVistaDialog = ofd.GetType().GetMethod("CreateVistaDialog", flags);
            var onBeforeVistaDialog = typeof(FileDialog).GetMethod("OnBeforeVistaDialog", flags);
            var getOptions = typeof(FileDialog).GetMethod("GetOptions", flags);
            if (createVistaDialog == null || onBeforeVistaDialog == null || getOptions == null)
            {
                throw new InvalidOperationException("Vista folder dialog methods are unavailable.");
            }

            object dialog = createVistaDialog.Invoke(ofd, null);
            onBeforeVistaDialog.Invoke(ofd, new object[] { dialog });
            uint options = Convert.ToUInt32(getOptions.Invoke(ofd, null));
            options |= Convert.ToUInt32(Enum.Parse(fosType, "FOS_PICKFOLDERS"));
            GetComMethod(iFileDialogType, dialog, "SetOptions").Invoke(dialog, new object[] { options });

            object events = Activator.CreateInstance(eventsType, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, new object[] { ofd }, null);
            object[] adviseArgs = new object[] { events, 0u };
            GetComMethod(iFileDialogType, dialog, "Advise").Invoke(dialog, adviseArgs);
            uint cookie = Convert.ToUInt32(adviseArgs[1]);
            try
            {
                object showResult = GetComMethod(iFileDialogType, dialog, "Show").Invoke(dialog, new object[] { dialogOwner });
                int hr = showResult == null ? 0 : Convert.ToInt32(showResult);
                if (hr != 0)
                {
                    return "";
                }
                return Directory.Exists(ofd.FileName) ? ofd.FileName : Path.GetDirectoryName(ofd.FileName);
            }
            finally
            {
                GetComMethod(iFileDialogType, dialog, "Unadvise").Invoke(dialog, new object[] { cookie });
                GC.KeepAlive(events);
                if (fallbackOwner != null)
                {
                    fallbackOwner.Hide();
                }
                if (attached)
                {
                    AttachThreadInput(ourThread, ownerThread, false);
                }
            }
        }
    }

    private static MethodInfo GetComMethod(Type type, object instance, string name)
    {
        var method = type.GetMethod(name)
            ?? instance.GetType().GetMethod(name);
        if (method == null)
        {
            foreach (var iface in type.GetInterfaces())
            {
                method = iface.GetMethod(name);
                if (method != null)
                {
                    break;
                }
            }
        }
        if (method == null)
        {
            throw new MissingMethodException(type.FullName, name);
        }
        return method;
    }

    private static IntPtr GetTopLevelWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }
        IntPtr root = GetAncestor(hwnd, GA_ROOT);
        return root != IntPtr.Zero ? root : hwnd;
    }

    private static void StartRaiseDialogWindow()
    {
        var thread = new Thread(RaiseOwnVisibleWindow);
        thread.IsBackground = true;
        thread.Start();
    }

    private static void RaiseOwnVisibleWindow()
    {
        uint pid = GetCurrentProcessId();
        for (int i = 0; i < 40; i++)
        {
            Thread.Sleep(50);
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
            {
                uint windowPid;
                GetWindowThreadProcessId(hwnd, out windowPid);
                if (windowPid != pid || !IsWindowVisible(hwnd) || hwnd == lParam)
                {
                    return true;
                }
                found = hwnd;
                return false;
            }, IntPtr.Zero);
            if (found != IntPtr.Zero)
            {
                SetWindowPos(found, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                BringWindowToTop(found);
                SetForegroundWindow(found);
                return;
            }
        }
    }

    private static Form CreateOwnerWindow()
    {
        var owner = new Form();
        owner.ShowInTaskbar = false;
        owner.FormBorderStyle = FormBorderStyle.None;
        owner.StartPosition = FormStartPosition.Manual;
        owner.Location = new Point(-32000, -32000);
        owner.Size = new Size(1, 1);
        owner.TopMost = true;
        owner.Show();
        owner.BringToFront();
        return owner;
    }
}
"@

if (-not ('PilotDeckExplorerFolderDialog' -as [type])) {
    Add-Type -TypeDefinition $code -Language CSharp -ReferencedAssemblies System.Windows.Forms,System.Drawing
}

try {
    $picked = [PilotDeckExplorerFolderDialog]::PickFolder()
    if ($picked) {
        [Console]::Out.Write($picked)
    }
} catch {
    [Console]::Error.WriteLine('FOLDER_PICKER_ERROR')
    [Console]::Error.WriteLine([string]$_.FullyQualifiedErrorId)
    [Console]::Error.WriteLine([string]$_.CategoryInfo)
    [Console]::Error.WriteLine([string]$_.Exception.GetType().FullName)
    [Console]::Error.WriteLine([string]$_.Exception.Message)
    exit 2
}

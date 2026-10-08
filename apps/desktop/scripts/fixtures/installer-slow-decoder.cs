// Isolated UI-test decoder: make progress and cancellation deterministic, then
// run the real embedded 7-Zip. Never used in the shipped installer.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
class SlowDecoder
{
    static int Main(string[] args)
    {
        for (int i = 1; i <= 15; i++)
        {
            Console.WriteLine((i * 5) + "%");
            Thread.Sleep(400);
        }
        string decoder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "real-7za.exe");
        using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("decoder"))
        using (var output = File.Create(decoder)) input.CopyTo(output);
        var start = new ProcessStartInfo(decoder, String.Join(" ", args.Select(arg => "\"" + arg + "\"")));
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using (var process = Process.Start(start))
        {
            var stdout = Task.Run(() => process.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
            var stderr = Task.Run(() => process.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
            process.WaitForExit();
            Task.WaitAll(stdout, stderr);
            return process.ExitCode;
        }
    }
}

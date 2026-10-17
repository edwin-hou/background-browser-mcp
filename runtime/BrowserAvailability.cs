using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class BrowserAvailability
{
    private const string DefaultNodeExecutable = @"C:\Program Files\nodejs\node.exe";
    private static readonly string InstallationRoot = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
    private static readonly string ScriptPath = Path.Combine(InstallationRoot, "availability.cjs");
    private static readonly string ReceiptPath = Path.Combine(InstallationRoot, "availability-launcher-state.json");
    private static readonly int LauncherPid = GetLauncherPid();
    private static int? lastChildPid;

    [STAThread]
    private static int Main(string[] args)
    {
        // This executable uses the Windows GUI subsystem and never creates a window.
        // The first receipt precedes argument handling and every child process.
        if (!TryWriteReceipt("launcher-starting", null, null, null))
            return 1;

        if (args.Length > 1 ||
            (args.Length == 1 && args[0] != "--enable" && args[0] != "--disable"))
        {
            TryWriteReceipt("invalid-arguments", null, 2, null);
            return 2;
        }

        try
        {
            if (args.Length == 1)
            {
                string verb = args[0] == "--enable" ? "enable" : "disable";
                int policyExit = RunNode(args[0], verb);
                if (policyExit != 0 || args[0] == "--disable")
                    return policyExit;
            }

            return Supervise(
                delegate { return RunNode(null, "supervisor"); },
                delegate { return IsExplicitlyDisabled(Path.Combine(InstallationRoot, "availability-config.json")); },
                Thread.Sleep);
        }
        catch (Exception error)
        {
            // Never record exception messages, command lines, output, or credentials.
            TryWriteReceipt("launcher-error", lastChildPid, 1, error.HResult);
            return 1;
        }
    }

    // Internal seams permit fixture tests with no child processes or real waiting.
    internal static int Supervise(Func<int> runNode, Func<bool> isDisabled, Action<int> wait)
    {
        int attempt = 0;
        int[] delays = { 5000, 10000, 20000, 30000 };
        for (;;)
        {
            if (isDisabled())
            {
                TryWriteReceipt("supervisor-disabled", null, 0, null);
                return 0;
            }

            int exitCode;
            int? exceptionHResult = null;
            try
            {
                exitCode = runNode();
            }
            catch (Exception error)
            {
                // Startup failures use the same bounded retry as abnormal exits.
                // Never record exception text, command lines, or child output.
                exitCode = 1;
                exceptionHResult = error.HResult;
            }

            // Duplicate ownership and a disabled policy both exit Node normally.
            if (exitCode == 0)
                return 0;
            if (isDisabled())
            {
                TryWriteReceipt("supervisor-disabled", null, 0, null);
                return 0;
            }

            int delay = delays[Math.Min(attempt, delays.Length - 1)];
            if (attempt < delays.Length - 1)
                attempt++;
            TryWriteReceipt("supervisor-retry-wait", lastChildPid, exitCode, exceptionHResult);
            wait(delay);
        }
    }

    internal static bool IsExplicitlyDisabled(string configPath)
    {
        try
        {
            // This file contains only durable availability policy, never auth data.
            // Read at most 16 KiB even if another local process changes the file.
            byte[] bytes = new byte[16385];
            int count = 0;
            using (FileStream input = new FileStream(configPath, FileMode.Open,
                FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                int read;
                while (count < bytes.Length &&
                    (read = input.Read(bytes, count, bytes.Length - count)) > 0)
                    count += read;
            }
            if (count == 0 || count > 16384)
                return false;
            JavaScriptSerializer serializer = new JavaScriptSerializer
            {
                MaxJsonLength = 16384,
                RecursionLimit = 16
            };
            Dictionary<string, object> policy = serializer.DeserializeObject(
                new UTF8Encoding(false, true).GetString(bytes, 0, count)) as Dictionary<string, object>;
            object enabled;
            return policy != null && policy.TryGetValue("enabled", out enabled) &&
                enabled is bool && !(bool)enabled;
        }
        catch
        {
            // Missing or malformed policy defers to Node's own policy validation.
            return false;
        }
    }

    private static string ResolveNodeExecutable()
    {
        string setting = Path.Combine(InstallationRoot, "node-path.txt");
        if (!File.Exists(setting)) return DefaultNodeExecutable;
        if (new FileInfo(setting).Length > 4096) throw new InvalidDataException();
        string node = File.ReadAllText(setting).Trim();
        if (!Path.IsPathRooted(node) || !File.Exists(node) ||
            !String.Equals(Path.GetFileName(node), "node.exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException();
        return Path.GetFullPath(node);
    }

    private static int RunNode(string argument, string phase)
    {
        lastChildPid = null;
        TryWriteReceipt(phase + "-starting", null, null, null);

        using (Process child = new Process())
        {
            child.StartInfo = new ProcessStartInfo
            {
                FileName = ResolveNodeExecutable(),
                Arguments = "\"" + ScriptPath + "\"" +
                    (argument == null ? "" : " " + argument),
                WorkingDirectory = InstallationRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            if (!child.Start())
                throw new InvalidOperationException();

            lastChildPid = child.Id;
            TryWriteReceipt(phase + "-running", lastChildPid, null, null);

            // Drain both pipes concurrently into a sink; retain no output lines.
            Task stdoutDrain = child.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
            Task stderrDrain = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
            child.WaitForExit();

            int exitCode = child.ExitCode;
            int? drainError = null;
            try
            {
                Task.WaitAll(stdoutDrain, stderrDrain);
            }
            catch (Exception error)
            {
                drainError = error.HResult;
            }

            TryWriteReceipt(phase + "-exited", lastChildPid, exitCode, drainError);
            return exitCode;
        }
    }

    private static int GetLauncherPid()
    {
        using (Process current = Process.GetCurrentProcess())
            return current.Id;
    }

    private static bool TryWriteReceipt(string phase, int? childPid, int? exitCode, int? exceptionHResult)
    {
        string temporaryPath = ReceiptPath + "." +
            LauncherPid.ToString(CultureInfo.InvariantCulture) + ".tmp";
        try
        {
            // Every string is generated here from fixed phases or a fixed date format.
            // The last receipt replaces the previous one; no unbounded log is created.
            string json = "{\"phase\":\"" + phase +
                "\",\"timestamp\":\"" +
                DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) +
                "\",\"launcherPid\":" + LauncherPid.ToString(CultureInfo.InvariantCulture) +
                ",\"childPid\":" + JsonInteger(childPid) +
                ",\"exitCode\":" + JsonInteger(exitCode) +
                ",\"exceptionHResult\":" +
                (exceptionHResult.HasValue
                    ? "\"0x" + unchecked((uint)exceptionHResult.Value).ToString("X8", CultureInfo.InvariantCulture) + "\""
                    : "null") +
                "}";
            if (Encoding.UTF8.GetByteCount(json) > 1024)
                return false;

            File.WriteAllText(temporaryPath, json, new UTF8Encoding(false));
            if (File.Exists(ReceiptPath))
                File.Replace(temporaryPath, ReceiptPath, null);
            else
            {
                try
                {
                    File.Move(temporaryPath, ReceiptPath);
                }
                catch (IOException)
                {
                    // A second permitted launcher may have created the receipt.
                    if (!File.Exists(ReceiptPath))
                        throw;
                    File.Replace(temporaryPath, ReceiptPath, null);
                }
            }
            return true;
        }
        catch
        {
            return false;
        }
        finally
        {
            try
            {
                if (File.Exists(temporaryPath))
                    File.Delete(temporaryPath);
            }
            catch { }
        }
    }

    private static string JsonInteger(int? value)
    {
        return value.HasValue
            ? value.Value.ToString(CultureInfo.InvariantCulture)
            : "null";
    }
}

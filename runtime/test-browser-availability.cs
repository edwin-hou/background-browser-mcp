using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
internal static class BrowserAvailabilityRetryTests
{
    private static int checks;
    private static void Check(bool condition, string name) { if (!condition) throw new Exception(name); checks++; }
    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string config = Path.Combine(root, "test-policy.json");
        int runs = 0;
        List<int> delays = new List<int>();
        int result = BrowserAvailability.Supervise(delegate { runs++; return 0; }, delegate { return false; }, delays.Add);
        Check(result == 0 && runs == 1 && delays.Count == 0, "normal-zero-stops");
        runs = 0; delays.Clear();
        result = BrowserAvailability.Supervise(delegate { runs++; return runs < 3 ? 7 : 0; }, delegate { return false; }, delays.Add);
        Check(result == 0 && runs == 3 && delays.SequenceEqual(new[] { 5000, 10000 }), "nonzero-retries");
        runs = 0; delays.Clear();
        BrowserAvailability.Supervise(delegate { runs++; return runs < 8 ? 7 : 0; }, delegate { return false; }, delays.Add);
        Check(delays.SequenceEqual(new[] { 5000, 10000, 20000, 30000, 30000, 30000, 30000 }), "backoff-capped");
        runs = 0; delays.Clear();
        BrowserAvailability.Supervise(delegate { runs++; if (runs == 1) throw new System.ComponentModel.Win32Exception(2, "PRIVATE-SENTINEL"); return 0; }, delegate { return false; }, delegate(int delay) {
            delays.Add(delay);
            string receipt = File.ReadAllText(Path.Combine(root, "availability-launcher-state.json"));
            Check(receipt.Contains("supervisor-retry-wait") && receipt.Contains("exceptionHResult") && !receipt.Contains("PRIVATE-SENTINEL") && receipt.Length <= 1024, "safe-exception-receipt");
        });
        Check(runs == 2 && delays.SequenceEqual(new[] { 5000 }), "startup-exception-retries");
        runs = 0; delays.Clear();
        BrowserAvailability.Supervise(delegate { runs++; return 7; }, delegate { return true; }, delays.Add);
        Check(runs == 0 && delays.Count == 0, "disabled-prevents-start");
        bool disabled = false; runs = 0; delays.Clear();
        BrowserAvailability.Supervise(delegate { runs++; disabled = true; return 7; }, delegate { return disabled; }, delays.Add);
        Check(runs == 1 && delays.Count == 0, "disabled-after-failure-prevents-retry");
        disabled = false; runs = 0; delays.Clear();
        BrowserAvailability.Supervise(delegate { runs++; return 7; }, delegate { return disabled; }, delegate(int delay) { delays.Add(delay); disabled = true; });
        Check(runs == 1 && delays.SequenceEqual(new[] { 5000 }), "disabled-during-wait-prevents-next-start");
        File.WriteAllText(config, "{\"enabled\":false}"); Check(BrowserAvailability.IsExplicitlyDisabled(config), "policy-false");
        File.WriteAllText(config, "{\"enabled\":true}"); Check(!BrowserAvailability.IsExplicitlyDisabled(config), "policy-true");
        File.Delete(config); Check(!BrowserAvailability.IsExplicitlyDisabled(config), "policy-missing-defers");
        File.WriteAllText(config, "{"); Check(!BrowserAvailability.IsExplicitlyDisabled(config), "policy-malformed-defers");
        File.WriteAllText(config, ""); Check(!BrowserAvailability.IsExplicitlyDisabled(config), "policy-empty-defers");
        File.WriteAllText(config, "{}"); Check(!BrowserAvailability.IsExplicitlyDisabled(config), "policy-no-enabled-defers");
        File.WriteAllText(config, new string(' ', 16385)); Check(!BrowserAvailability.IsExplicitlyDisabled(config), "policy-oversized-defers");
        File.WriteAllText(config, "null"); Check(!BrowserAvailability.IsExplicitlyDisabled(config), "policy-null-defers");
        File.WriteAllText(config, "{\"enabled\":\"false\"}"); Check(!BrowserAvailability.IsExplicitlyDisabled(config), "policy-string-false-defers");
        Console.WriteLine("{\"ok\":true,\"checks\":" + checks + ",\"realServicesTouched\":false,\"realLauncherStarted\":false,\"browserLaunched\":false}");
        return 0;
    }
}

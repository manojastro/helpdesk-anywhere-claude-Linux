using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;

using Microsoft.Win32;

namespace HelpdeskAnywhere.Applet.Features;

/// <summary>
/// System information for the technician's System tab (Platform 2.0, Phase 2b),
/// collected only when the technician asks, never in the background.
///
/// What is collected is what a helpdesk needs to diagnose a machine, and no more:
/// no MAC addresses, no serial numbers, no installed-software inventory, no
/// file names. Each part is gathered independently, so one unavailable source
/// (a locked registry key, a removed adapter) leaves a gap, not an error.
/// </summary>
internal static class SystemInfoCollector
{
    public static Dictionary<string, object?> Collect()
    {
        var info = new Dictionary<string, object?>();
        void Try(string key, Func<object?> get)
        {
            try { info[key] = get(); } catch { info[key] = null; }
        }

        Try("hostname", () => Environment.MachineName);
        Try("user", () => Environment.UserName);
        Try("userDomain", () => Environment.UserDomainName);
        Try("domain", () =>
        {
            var d = IPGlobalProperties.GetIPGlobalProperties().DomainName;
            return string.IsNullOrEmpty(d) ? null : d;
        });

        const string cv = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        Try("osName", () => Registry.GetValue($@"HKEY_LOCAL_MACHINE\{cv}", "ProductName", null) as string);
        Try("osVersion", () => Registry.GetValue($@"HKEY_LOCAL_MACHINE\{cv}", "DisplayVersion", null) as string);
        Try("osBuild", () =>
        {
            var build = Registry.GetValue($@"HKEY_LOCAL_MACHINE\{cv}", "CurrentBuild", null) as string;
            var ubr = Registry.GetValue($@"HKEY_LOCAL_MACHINE\{cv}", "UBR", null);
            return build is null ? null : ubr is int u ? $"{build}.{u}" : build;
        });
        Try("osDescription", () => RuntimeInformation.OSDescription);
        Try("architecture", () => RuntimeInformation.OSArchitecture.ToString());

        Try("cpu", () => (Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString", null) as string)?.Trim());
        Try("cpuLogicalCores", () => Environment.ProcessorCount);
        Try("memory", () => Interop.Memory.Physical() is { } m ? new { totalBytes = m.Total, availableBytes = m.Available } : null);

        Try("disks", () => DriveInfo.GetDrives()
            .Where(d => d.DriveType == DriveType.Fixed && d.IsReady)
            .Select(d => new { name = d.Name.TrimEnd('\\'), label = d.VolumeLabel, format = d.DriveFormat, totalBytes = d.TotalSize, freeBytes = d.AvailableFreeSpace })
            .ToList());

        Try("network", () => NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .Select(n =>
            {
                var p = n.GetIPProperties();
                return new
                {
                    name = n.Name,
                    description = n.Description,
                    type = n.NetworkInterfaceType.ToString(),
                    speedMbps = n.Speed > 0 ? n.Speed / 1_000_000 : (long?)null,
                    ipv4 = p.UnicastAddresses.Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork).Select(a => a.Address.ToString()).ToList(),
                    gateway = p.GatewayAddresses.Select(g => g.Address).FirstOrDefault(g => g.AddressFamily == AddressFamily.InterNetwork)?.ToString(),
                    dnsSuffix = string.IsNullOrEmpty(p.DnsSuffix) ? null : p.DnsSuffix,
                    primary = p.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork),
                };
            })
            .ToList());

        Try("uptimeSeconds", () => Environment.TickCount64 / 1000);
        Try("timeZone", () => TimeZoneInfo.Local.DisplayName);
        Try("battery", () =>
        {
            var ps = SystemInformation.PowerStatus;
            if (ps.BatteryChargeStatus.HasFlag(BatteryChargeStatus.NoSystemBattery)) return null;
            return new
            {
                percent = (int)Math.Round(ps.BatteryLifePercent * 100),
                pluggedIn = ps.PowerLineStatus == PowerLineStatus.Online,
                charging = ps.BatteryChargeStatus.HasFlag(BatteryChargeStatus.Charging),
            };
        });

        Try("agentVersion", () => Assembly.GetEntryAssembly()?.GetName().Version?.ToString());
        Try("agentStartedAt", () => new DateTimeOffset(System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime()).ToUnixTimeMilliseconds());
        Try("protocolVersion", () => Shared.FeatureProtocol.Version);
        return info;
    }
}

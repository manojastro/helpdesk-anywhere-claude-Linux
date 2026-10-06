/**
 * Saved script library (Technician Platform 2.0, Phase 2).
 *
 * Two sources:
 *   - BUILT-IN scripts, shipped here, read-only, identical for every
 *     organisation (ids `builtin:<slug>`);
 *   - ORGANISATION scripts in `script_library`, versioned, managed by
 *     administrators (`scripts.manage`).
 *
 * The library does not grant anything: running any script still needs the
 * technician's `allowScripts` limit and an active, un-held session, exactly as
 * an ad-hoc script does. What it adds is provenance. When the console runs a
 * library script it names it (`libraryRef: {id, version}` on `agent.exec`), and
 * the relay checks that the text, shell and privilege it is about to forward are
 * exactly that version's. Only then does the timeline say "ran <name> v<n>"; a
 * mismatch is recorded as an ordinary ad-hoc script with `libraryMismatch`.
 */

import { createHash } from "node:crypto";

import { query } from "./db/pool.js";

export type RunAs = "user" | "system";
export type Shell = "powershell" | "cmd";

export interface LibraryScript {
  id: string;
  version: number;
  name: string;
  description: string;
  category: string;
  shell: Shell;
  body: string;
  runAs: RunAs;
  builtin: boolean;
  createdByName: string;
  updatedAt: string | null;
}

export const CATEGORIES = [
  "System Information",
  "Network Diagnostics",
  "Disk Space",
  "Windows Services",
  "Application Troubleshooting",
  "Log Collection",
] as const;

const BUILTIN_DEFS: Array<Omit<LibraryScript, "version" | "builtin" | "createdByName" | "updatedAt">> = [
  {
    id: "builtin:computer-summary",
    name: "Computer summary",
    description: "Name, Windows edition and build, architecture, domain, memory and last boot.",
    category: "System Information",
    shell: "powershell",
    runAs: "user",
    body: [
      "Get-ComputerInfo -Property CsName, OsName, OsVersion, OsBuildNumber, OsArchitecture, CsDomain, CsTotalPhysicalMemory, OsLastBootUpTime |",
      "  Format-List",
    ].join("\n"),
  },
  {
    id: "builtin:ip-configuration",
    name: "IP configuration",
    description: "Every network adapter's addresses, gateway and DNS servers (ipconfig /all).",
    category: "Network Diagnostics",
    shell: "cmd",
    runAs: "user",
    body: "ipconfig /all",
  },
  {
    id: "builtin:internet-check",
    name: "Internet connectivity check",
    description: "DNS resolution and an HTTPS connection test to www.microsoft.com.",
    category: "Network Diagnostics",
    shell: "powershell",
    runAs: "user",
    body: [
      "Resolve-DnsName www.microsoft.com -Type A | Select-Object -First 3 Name, IPAddress | Format-Table -AutoSize",
      "Test-NetConnection -ComputerName www.microsoft.com -Port 443 |",
      "  Select-Object ComputerName, RemoteAddress, InterfaceAlias, TcpTestSucceeded | Format-List",
    ].join("\n"),
  },
  {
    id: "builtin:flush-dns",
    name: "Flush DNS cache",
    description: "Clears the local DNS resolver cache.",
    category: "Network Diagnostics",
    shell: "cmd",
    runAs: "user",
    body: "ipconfig /flushdns",
  },
  {
    id: "builtin:disk-space",
    name: "Disk space",
    description: "Used and free space on every local drive, in GB.",
    category: "Disk Space",
    shell: "powershell",
    runAs: "user",
    body: [
      "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } |",
      "  Select-Object Name, @{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}}, @{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} |",
      "  Format-Table -AutoSize",
    ].join("\n"),
  },
  {
    id: "builtin:stopped-auto-services",
    name: "Automatic services not running",
    description: "Services set to start automatically that are currently stopped.",
    category: "Windows Services",
    shell: "powershell",
    runAs: "user",
    body: [
      "Get-CimInstance Win32_Service -Filter \"StartMode='Auto' AND State<>'Running'\" |",
      "  Select-Object Name, DisplayName, State | Format-Table -AutoSize",
    ].join("\n"),
  },
  {
    id: "builtin:restart-spooler",
    name: "Restart Print Spooler",
    description: "Restarts the Print Spooler service and shows its status. Needs an elevated session.",
    category: "Windows Services",
    shell: "powershell",
    runAs: "system",
    body: "Restart-Service -Name Spooler -Force\nGet-Service -Name Spooler | Format-List Name, Status, StartType",
  },
  {
    id: "builtin:top-memory",
    name: "Top processes by memory",
    description: "The 15 processes using the most memory.",
    category: "Application Troubleshooting",
    shell: "powershell",
    runAs: "user",
    body: [
      "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, Id,",
      "  @{n='MemoryMB';e={[math]::Round($_.WorkingSet64/1MB)}}, @{n='CPUs';e={[math]::Round($_.CPU,1)}} | Format-Table -AutoSize",
    ].join("\n"),
  },
  {
    id: "builtin:app-errors-24h",
    name: "Application errors (last 24 h)",
    description: "Up to 30 Error-level events from the Application log in the last 24 hours.",
    category: "Log Collection",
    shell: "powershell",
    runAs: "user",
    body: [
      "Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 2; StartTime = (Get-Date).AddHours(-24) } -MaxEvents 30 -ErrorAction SilentlyContinue |",
      "  Select-Object TimeCreated, ProviderName, Id, @{n='Message';e={($_.Message -split \"`n\")[0]}} | Format-Table -Wrap",
    ].join("\n"),
  },
  {
    id: "builtin:system-errors-24h",
    name: "System errors (last 24 h)",
    description: "Up to 30 Error-level events from the System log in the last 24 hours.",
    category: "Log Collection",
    shell: "powershell",
    runAs: "user",
    body: [
      "Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 2; StartTime = (Get-Date).AddHours(-24) } -MaxEvents 30 -ErrorAction SilentlyContinue |",
      "  Select-Object TimeCreated, ProviderName, Id, @{n='Message';e={($_.Message -split \"`n\")[0]}} | Format-Table -Wrap",
    ].join("\n"),
  },
];

export const BUILTIN_SCRIPTS: readonly LibraryScript[] = BUILTIN_DEFS.map((d) => ({
  ...d, version: 1, builtin: true, createdByName: "Helpdesk Anywhere", updatedAt: null,
}));

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Row {
  id: string; version: number; name: string; description: string; category: string; shell: Shell; body: string;
  run_as: RunAs; created_by_name: string; created_at: Date; archived_at: Date | null;
}

function fromRow(r: Row): LibraryScript {
  return {
    id: r.id, version: r.version, name: r.name, description: r.description, category: r.category, shell: r.shell,
    body: r.body, runAs: r.run_as, builtin: false, createdByName: r.created_by_name, updatedAt: r.created_at.toISOString(),
  };
}

/** The current, non-archived version of every organisation script, plus the built-ins. */
export async function listScripts(orgId: string, { includeArchived = false } = {}): Promise<Array<LibraryScript & { archived: boolean }>> {
  const { rows } = await query<Row>(
    `SELECT DISTINCT ON (id) id, version, name, description, category, shell, body, run_as, created_by_name, created_at, archived_at
       FROM script_library WHERE org_id = $1 ORDER BY id, version DESC`,
    [orgId],
  );
  const org = rows.filter((r) => includeArchived || r.archived_at === null).map((r) => ({ ...fromRow(r), archived: r.archived_at !== null }));
  const all = [...BUILTIN_SCRIPTS.map((s) => ({ ...s, archived: false })), ...org];
  return all.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** One exact version (archived versions included: history must still resolve). */
export async function getScriptVersion(orgId: string, id: string, version: number): Promise<(LibraryScript & { archived: boolean }) | null> {
  if (id.startsWith("builtin:")) {
    const b = BUILTIN_SCRIPTS.find((s) => s.id === id && s.version === version);
    return b ? { ...b, archived: false } : null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(version) || version < 1) return null;
  const { rows } = await query<Row>(
    `SELECT id, version, name, description, category, shell, body, run_as, created_by_name, created_at, archived_at
       FROM script_library WHERE org_id = $1 AND id = $2 AND version = $3`,
    [orgId, id, version],
  );
  return rows[0] ? { ...fromRow(rows[0]), archived: rows[0].archived_at !== null } : null;
}

export type LibraryCheck =
  | { ok: true; script: LibraryScript }
  | { ok: false; reason: "unknown" | "archived" | "text_differs" | "shell_differs" | "privilege_differs" };

/**
 * Is what the relay is about to forward exactly library script `ref`? Compares
 * the full text (by SHA-256), the shell and the privilege. Never throws for bad
 * input; a database error propagates (the caller treats it as "not verified").
 */
export async function verifyLibraryRun(
  orgId: string,
  ref: unknown,
  run: { shell: unknown; script: string; asSystem: boolean },
): Promise<LibraryCheck> {
  const r = ref as { id?: unknown; version?: unknown } | null;
  if (typeof r?.id !== "string" || typeof r.version !== "number") return { ok: false, reason: "unknown" };
  const script = await getScriptVersion(orgId, r.id.slice(0, 100), r.version);
  if (!script) return { ok: false, reason: "unknown" };
  if (script.archived) return { ok: false, reason: "archived" };
  if (sha256(script.body) !== sha256(run.script)) return { ok: false, reason: "text_differs" };
  if (script.shell !== run.shell) return { ok: false, reason: "shell_differs" };
  if ((script.runAs === "system") !== run.asSystem) return { ok: false, reason: "privilege_differs" };
  return { ok: true, script };
}

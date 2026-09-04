using HelpdeskAnywhere.Applet.Elevation;

// PLAN 5.2b: "map errors to clear console messages rather than raw codes".
// The messages are what the agent acts on, and CLAUDE.md constraint #6 says
// none of them may carry a credential.

var pass = 0;
var fail = 0;

void Check(string name, bool ok, string detail = "")
{
    if (ok) pass++; else fail++;
    Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {name}{(detail.Length > 0 ? $"  — {detail}" : "")}");
}

Console.WriteLine("\n=== ElevationErrors — Win32 code → something the agent can act on ===\n");

int[] mapped =
[
    ElevationErrors.ErrorCancelled,
    ElevationErrors.ErrorLogonFailure,
    ElevationErrors.ErrorAccountRestriction,
    ElevationErrors.ErrorAccountDisabled,
    ElevationErrors.ErrorLogonTypeNotGranted,
    ElevationErrors.ErrorAccountLockedOut,
    ElevationErrors.ErrorPasswordMustChange,
    ElevationErrors.ErrorPasswordExpired,
    ElevationErrors.ErrorNoSuchDomain,
    ElevationErrors.ErrorInvalidLogonHours,
    ElevationErrors.ErrorInvalidWorkstation,
    ElevationErrors.ErrorAccessDenied,
];

Check("every code PLAN 5.2b names has its own message",
    mapped.Select(ElevationErrors.Describe).Distinct().Count() == mapped.Length);

Check("no message is just a number",
    mapped.All(c => !ElevationErrors.Describe(c).Contains(c.ToString())));

Check("an unknown code still says what happened, with the number to look up",
    ElevationErrors.Describe(999).Contains("999") &&
    ElevationErrors.Describe(999).Contains("Elevation failed"),
    ElevationErrors.Describe(999));

// The two the plan singles out: they are different problems and must read as
// different problems (PLAN 5.2b).
Check("1326 reads as a bad username/password",
    ElevationErrors.Describe(1326).Contains("username or password"),
    ElevationErrors.Describe(1326));
Check("1385 reads as an account that cannot log on interactively, not a typo",
    ElevationErrors.Describe(1385).Contains("interactively") &&
    !ElevationErrors.Describe(1385).Contains("password"),
    ElevationErrors.Describe(1385));
Check("1223 tells the agent the USER declined, and what to ask for",
    ElevationErrors.Describe(1223).Contains("declined") &&
    ElevationErrors.Describe(1223).Contains("Yes"),
    ElevationErrors.Describe(1223));
Check("1355 hints at the local-account case, which is the usual cause",
    ElevationErrors.Describe(1355).Contains("domain field empty"));

Check("retrying is pointless for account-state failures, not for a typo",
    ElevationErrors.IsRetryPointless(1385) &&
    ElevationErrors.IsRetryPointless(1331) &&
    ElevationErrors.IsRetryPointless(1909) &&
    !ElevationErrors.IsRetryPointless(1326) &&
    !ElevationErrors.IsRetryPointless(1223));

// Constraint #6: these strings go to the console and the audit log.
string[] forbidden = ["password:", "pwd", "secret", "credential="];
Check("no message can carry a credential value",
    mapped.Append(999).Select(ElevationErrors.Describe)
        .All(m => forbidden.All(f => !m.Contains(f, StringComparison.OrdinalIgnoreCase))));

Console.WriteLine($"\n  {(fail == 0 ? "ALL PASS" : $"{fail} FAILED")}  ({pass} passed)\n");
return fail == 0 ? 0 : 1;

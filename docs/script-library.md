# Saved script library

Technician Platform 2.0, Phase 2. Code: `server/src/scriptLibrary.ts`,
`server/migrations/004_script_library.sql`, relay check in `signaling.ts relayExec`,
console Scripts tab, admin portal → **Script library**.

## What it is

* **Built-in scripts** (10, read-only, shipped in code) across six categories: System
  Information, Network Diagnostics, Disk Space, Windows Services, Application
  Troubleshooting, Log Collection.
* **Organisation scripts**, created by administrators. Fields: id, version, name,
  description, category, shell (PowerShell / Command Prompt), body, *runs as* (signed-in
  user, or SYSTEM — needs an elevated session), created by, created at.

## Rules

| Rule | Enforced where |
|---|---|
| Only `Admin` can create, edit or archive (`scripts.manage`); Supervisor and Auditor can read (`scripts.read`) | admin API, every route |
| Editing never overwrites: each save is a new version; earlier versions stay | `PUT /api/admin/scripts/:id` inserts `version + 1` |
| Archiving hides a script from technicians, keeps its history, blocks further edits | `POST /api/admin/scripts/:id/archive` |
| The audit trail records name, version and SHA-256 — not the body | `script.created` / `script.updated` / `script.archived` |
| **The library grants nothing.** Running a saved script needs exactly what an ad-hoc script needs: `allowScripts`, an active un-held session, the audit record written first | relay, unchanged |
| A run is recorded *as the saved script* only if the text (SHA-256), shell and privilege match that version exactly | relay `verifyLibraryRun`; otherwise `libraryMismatch: text_differs \| shell_differs \| privilege_differs \| unknown \| archived` |

The console sends `libraryRef: {id, version}` only while the editor still holds the
unmodified script; change one character and it is an ordinary ad-hoc script — still
run, still audited with its full text, just not credited to the library.

## API

| | |
|---|---|
| `GET /api/agent/scripts` | built-ins + current org scripts, and `canRun` |
| `GET /api/admin/scripts` | everything incl. archived, `categories`, `canManage` |
| `GET /api/admin/scripts/:id/versions` | every version with its SHA-256 |
| `POST /api/admin/scripts` | create (v1) |
| `PUT /api/admin/scripts/:id` | new version |
| `POST /api/admin/scripts/:id/archive` | archive |

## Not yet

* Cancel a running script — needs an applet message (Phase 2b). Scripts still stop at
  the applet's 120 s timeout, as before.
* Per-script role restrictions beyond "runs as SYSTEM needs elevation".

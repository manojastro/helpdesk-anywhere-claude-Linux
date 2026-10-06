# File transfer, file manager, clipboard and system information

Technician Platform 2.0, Phase 2b — **the first Windows applet change of 2.0.** Wire format:
`shared/protocol.md` → "Phase 2b". Status: implemented, Linux-verified, **Windows acceptance
pending (MT-15)**.

## Where the code is

| Side | Files |
|---|---|
| Relay | `server/src/features.ts` (validation, authorisation, accounting, records), hook in `signaling.ts` |
| Console | `server/public/files.js` (file manager + transfers), clipboard / system / Stop in `portal.js` |
| Applet | `windows/Applet/Features/` — `FeatureHost`, `FileService`, `TransferManager`, `PathPolicy`, `SystemInfoCollector`; `Interop/Memory.cs`; `Shared/ProtocolFeatures.cs` |
| Applet edits to existing files | `AppletContext` (create after consent, route the switch's `default`, dispose at teardown), `SessionClient.SendJoin` (version + capabilities), `Protocol.cs` `HostJoin` (two optional fields), `ScriptRunner.Cancel` |

**Not touched:** anything on the golden list (`docs/golden-features.md`) — capture, input,
the desktop watch, the elevated service, the pipe, `Program.cs`. `source/25` still pins those
to the golden tag; `source/42` allow-lists exactly the files above; `source/45` checks the
properties below in the C# source.

## Design choices, and why

* **JSON chunks, not new binary frames.** Base64 costs ~33 % more bytes, but the video framing
  — shared with the Secure Desktop helper — stays exactly as verified, and the relay can
  account every chunk.
* **Applet runs everything as the signed-in customer.** Even in an elevated session, file
  operations and clipboard happen in the medium-integrity applet process, never through the
  SYSTEM service. Windows ACLs bound what the technician can reach.
* **`PathPolicy` refuses rather than normalises**: relative paths, `..`, UNC, `\\?\` / `\\.\`,
  alternate data streams, reserved device names, forbidden characters, trailing dots/spaces.
  Unit-tested on Linux (`dotnet/PathPolicyTests`).
* **Uploads never overwrite** (`name (1).ext`), are written as `.hdapart` and renamed only
  after the size and SHA-256 match; anything cancelled, failed or interrupted is deleted.
* **Deletes are not recursive**: a file or an empty folder only. Rename stays in the same
  folder. Drive roots cannot be renamed or deleted. (Copy/move between folders: not built.)
* **Flow control**: at most 8 unacknowledged 48 KiB chunks either way, so a large transfer
  cannot queue ahead of End Session on the applet's control channel.
* **The customer always knows**: every incoming file, outgoing file, folder change and
  clipboard read/write shows on their session indicator.
* **Downloads are assembled in the browser** — capped at 256 MB each. Uploads stream from disk
  up to the server limit (1 GiB default); end-to-end SHA-256 is checked up to 256 MB.
* **Clipboard**: text only, ≤ 60 000 characters, explicit Send / Get buttons, never logged or
  stored (length only), fields cleared when the dialog closes.
* **System information**: collected only on request; no MAC addresses, serials or software
  inventory.
* **Script Stop**: user-level scripts only — a SYSTEM script runs in the elevated service, and
  stopping it would mean changing the golden pipe; it still stops at the 120 s timeout.

## Configuration

| Variable | Default | |
|---|---|---|
| `MAX_FILE_TRANSFER_BYTES` | 1073741824 (1 GiB) | largest single file either way |
| `MAX_TRANSFERS_PER_SESSION` | 3 | concurrent transfers in one session |
| `users.allow_file_transfer` | true | per technician, admin portal → Edit |

## Building an applet to test

`./scripts/build-windows.sh` by default writes `server/public/download/HelpdeskAnywhere.exe`,
which `docker-compose.yml` **bind-mounts into the running app** — it changes what customers
download. For an untested build use `--out`:

```bash
./scripts/build-windows.sh --server https://<test-host> --out ~/hda-artifacts/platform-v2
```

The server it dials must run this branch for the Phase 2b features to appear; against an older
server the new applet behaves exactly like the old one (protocol version 1).

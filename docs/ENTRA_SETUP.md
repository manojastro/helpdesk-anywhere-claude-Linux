# Microsoft Entra ID setup

Helpdesk Anywhere signs technicians and administrators in with **one** Entra app
registration, used by **two** applications:

| Application | Hostname (example) | Redirect URI |
|---|---|---|
| Technician console | `app.example.org` (`PUBLIC_HOST`) | `https://app.example.org/auth/callback` |
| Admin portal | `admin.example.org` (`ADMIN_PUBLIC_HOST`) | `https://admin.example.org/auth/callback` |

The customer who runs the Windows applet never signs in. Nothing here changes
that flow.

What the server does with Entra: OpenID Connect authorization-code flow with
PKCE (`openid-client`), confidential client (client secret), scopes
`openid profile email` only. It validates issuer (the tenant-specific v2.0
issuer), audience, ID-token signature (tenant JWKS), expiry, `state` and
`nonce`, then requires `tid` = `ENTRA_TENANT_ID`. The stable identity is
**tenant ID + object ID (`oid`)** — never the e-mail address. App roles arrive
in the ID token's `roles` claim. The server calls **no Microsoft Graph API** and
needs no Graph application permissions; the portal therefore cannot, and does
not claim to, change anyone's Entra assignment.

## 1. Register the application

Entra admin center (<https://entra.microsoft.com>) → **Identity → Applications →
App registrations → New registration**.

| Field | Value |
|---|---|
| Name | `Helpdesk Anywhere` |
| Supported account types | **Accounts in this organizational directory only (Single tenant)** |
| Redirect URI | Platform **Web**, `https://app.example.org/auth/callback` |

Select **Register**. On the **Overview** page copy:

* **Application (client) ID** → `ENTRA_CLIENT_ID`
* **Directory (tenant) ID** → `ENTRA_TENANT_ID`

## 2. Authentication

**Authentication** blade:

1. Under **Web → Redirect URIs**, **Add URI**: `https://admin.example.org/auth/callback`.
   Both URIs must match `PUBLIC_HOST` / `ADMIN_PUBLIC_HOST` exactly (scheme,
   host, path; no trailing slash).
2. **Implicit grant and hybrid flows**: leave **Access tokens** and **ID tokens**
   **unchecked** (the app uses the authorization-code flow).
3. **Allow public client flows**: **No**.
4. Save.

## 3. Client secret

**Certificates & secrets → Client secrets → New client secret**. Pick an expiry
you will actually rotate before (e.g. 180 days). Copy the secret **Value** (not
the Secret ID) immediately → `ENTRA_CLIENT_SECRET`. It is shown once.

Rotation: add a second secret, put its value in `.env`, `docker compose
--profile tls up -d app`, then delete the old secret.

## 4. App roles

**App roles → Create app role**, four times. The **Value** is what the server
matches, case-sensitively:

| Display name | Allowed member types | Value | Description |
|---|---|---|---|
| Admin | Users/Groups | `Admin` | Manage access, view all sessions, transcripts, notes, reports and audit |
| Supervisor | Users/Groups | `Supervisor` | Run sessions; view and export their team's sessions; end live sessions |
| Agent | Users/Groups | `Agent` | Run remote-support sessions from the technician console |
| Auditor | Users/Groups | `Auditor` | Read-only oversight: sessions, transcripts, notes, reports and audit |

Tick **Do you want to enable this app role?** for each.

What each role can do in the application (the server enforces this; the UI
merely reflects it):

| | Admin | Supervisor | Agent | Auditor |
|---|:-:|:-:|:-:|:-:|
| Technician console | ✔ | ✔ | ✔ | — |
| Admin portal | ✔ | ✔ | — | ✔ |
| Session history (admin portal) | organisation | own team + own | — | organisation |
| Transcripts / notes | ✔ | team | writes own session notes in the console | ✔ |
| Reports (PDF/CSV) | ✔ | team | — | ✔ |
| End a live session | ✔ | team | own (console) | — |
| Activate / suspend / edit people | ✔ | — | — | — |
| Audit trail | ✔ | — | — | ✔ |

An administrator can only **narrow** a role per person (console use, scripts,
elevation, export, concurrent sessions), never widen it.

## 5. API permissions and token claims

1. **API permissions**: the registration starts with Microsoft Graph
   `User.Read` (delegated). The server does not call Graph; you may remove it
   and add Microsoft Graph delegated **`openid`**, **`profile`**, **`email`**
   instead. Select **Grant admin consent for <tenant>** so users are not
   prompted.
2. **Token configuration → Add optional claim → ID → `email`** (accept the
   prompt to add the Graph `email` permission). Without it the e-mail column
   falls back to `preferred_username`. E-mail is display data only.

## 6. Enterprise application: who may sign in

Entra admin center → **Identity → Applications → Enterprise applications →
Helpdesk Anywhere**:

1. **Properties → Assignment required?** → **Yes** (recommended). Unassigned
   people then cannot sign in at all. (With **No**, they can reach the sign-in
   step; the server records them without an app role and refuses them, and the
   admin portal shows "Assignment required in Entra".)
2. **Users and groups → Add user/group** → choose people (or groups — group
   assignment needs Entra ID P1/P2) → **Select a role** → Admin, Supervisor,
   Agent or Auditor → **Assign**.

Removing the assignment, or the role, blocks the person's **next** sign-in. To
block someone **immediately**, also suspend them in the admin portal: that
revokes their browser sessions and closes any live session they are running.
Browser sign-ins otherwise last at most `AUTH_MAX_HOURS` (default 12) and end
after `AUTH_IDLE_MINUTES` (default 120) idle.

Optional but recommended: a **Conditional Access** policy requiring MFA for the
Helpdesk Anywhere app (Entra ID P1).

## 7. First administrator (bootstrap)

1. Entra admin center → **Users** → yourself → copy **Object ID**.
2. Assign yourself the **Admin** app role (step 6).
3. Put the Object ID in `.env`: `BOOTSTRAP_ADMIN_OIDS=<your object id>` and
   restart the app.
4. Sign in at `https://admin.example.org`. Because your identity (a) is listed,
   (b) holds the Admin role in the verified token, and (c) the organisation has
   no active administrator yet, you are activated automatically. This is
   recorded as `access.bootstrap_admin` in the audit trail.
5. Clear `BOOTSTRAP_ADMIN_OIDS` and restart. It cannot re-activate a suspended
   account and does nothing once an active admin exists, but leaving it set has
   no purpose.

There is no unauthenticated setup route.

## 8. Everyone else

1. Assign them an app role (step 6).
2. They sign in once (console for technicians, admin portal for oversight
   roles) and are told access is **pending**.
3. An Admin opens **Agents & access → Pending**, reviews the identity (name,
   e-mail, Entra object ID, roles), assigns an **internal agent ID** and
   **team**, and selects **Activate**.
4. They sign in again.

## 9. `.env` values

```dotenv
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=<client secret VALUE>
PUBLIC_HOST=app.example.org
ADMIN_PUBLIC_HOST=admin.example.org
BOOTSTRAP_ADMIN_OIDS=<your object id>     # clear after first sign-in
# Only if the redirect URIs differ from https://<host>/auth/callback:
OIDC_REDIRECT_URI_AGENT=
OIDC_REDIRECT_URI_ADMIN=
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `AADSTS50011` redirect URI mismatch | The URI in step 2 differs from `https://<PUBLIC_HOST or ADMIN_PUBLIC_HOST>/auth/callback` |
| `AADSTS7000215` invalid client secret | You copied the Secret ID, or the secret expired |
| Sign-in returns "not assigned … app role" | No app role assignment (step 6), or the role Value is misspelt |
| "pending" | Working as intended — an Admin must activate the person |
| "portal is for administrators, supervisors and auditors" | An Agent-only identity tried the admin portal |
| "belongs to a different organisation directory" | Signed in with an account from another tenant |
| Server log: `could not start Entra sign-in` | Outbound HTTPS to `login.microsoftonline.com` blocked, or wrong `ENTRA_TENANT_ID` |

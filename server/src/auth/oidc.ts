/**
 * Microsoft Entra ID sign-in — OpenID Connect authorization code flow with PKCE,
 * via `openid-client` (maintained, certified OIDC RP library).
 *
 * The library validates: issuer (exactly the tenant-specific v2.0 issuer found by
 * discovery), audience (our client id), ID-token signature against the tenant's
 * JWKS (`enableNonRepudiationChecks` — without it a token received over TLS from
 * the token endpoint would be trusted on transport alone), expiry / not-before,
 * `state` and `nonce`. This module adds the application rule that `tid` must be
 * the one configured tenant (identity.ts) and requires `oid`.
 *
 * The pre-login transaction (state, nonce, PKCE verifier) is held server-side in
 * memory for ten minutes, keyed by a random id in a short-lived HttpOnly cookie.
 * Tokens are never stored: only the claims needed to resolve the user are read,
 * and the access/refresh tokens are dropped on the floor. No Microsoft Graph
 * permissions are requested — `openid profile email` only; app roles arrive in
 * the ID token's `roles` claim.
 */

import { randomBytes } from "node:crypto";

import * as client from "openid-client";

import { config, redirectUri, type Portal } from "../config.js";
import type { VerifiedClaims } from "./identity.js";

const TX_TTL_MS = 10 * 60_000;
const MAX_PENDING = 5_000;

interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  portal: Portal;
  createdAt: number;
}

const pending = new Map<string, PendingLogin>();

let discovered: Promise<client.Configuration> | null = null;

function configuration(): Promise<client.Configuration> {
  discovered ??= client
    .discovery(
      new URL(`https://login.microsoftonline.com/${encodeURIComponent(config.entraTenantId)}/v2.0`),
      config.entraClientId,
      undefined,
      client.ClientSecretPost(config.entraClientSecret),
      { execute: [client.enableNonRepudiationChecks] },
    )
    .catch((err: unknown) => {
      discovered = null;  // retry discovery on the next sign-in attempt
      throw err;
    });
  return discovered;
}

export function entraConfigured(): boolean {
  return config.entraTenantId !== "" && config.entraClientId !== "" && config.entraClientSecret !== "";
}

function sweep(now = Date.now()): void {
  for (const [id, tx] of pending) if (now - tx.createdAt > TX_TTL_MS) pending.delete(id);
}

/** Begin a sign-in. Returns the Microsoft URL to redirect to and the transaction id for the cookie. */
export async function beginLogin(portal: Portal, returnTo: string): Promise<{ url: URL; txId: string }> {
  sweep();
  if (pending.size >= MAX_PENDING) throw new Error("too many sign-ins in progress");
  const cfg = await configuration();

  const verifier = client.randomPKCECodeVerifier();
  const tx: PendingLogin = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    verifier,
    returnTo,
    portal,
    createdAt: Date.now(),
  };
  const txId = randomBytes(24).toString("base64url");
  pending.set(txId, tx);

  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri(portal),
    scope: "openid profile email",
    response_type: "code",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state: tx.state,
    nonce: tx.nonce,
    prompt: "select_account",
  });
  return { url, txId };
}

/**
 * Complete a sign-in. `search` is the callback's raw query string. Throws on any
 * validation failure; the caller shows a generic error and logs only the message.
 */
export async function completeLogin(
  portal: Portal,
  txId: string,
  search: string,
): Promise<{ claims: VerifiedClaims; returnTo: string }> {
  const tx = pending.get(txId);
  pending.delete(txId);  // single use, success or not
  if (!tx || Date.now() - tx.createdAt > TX_TTL_MS) throw new Error("sign-in transaction missing or expired");
  // A transaction started on one portal cannot be completed on the other.
  if (tx.portal !== portal) throw new Error("sign-in transaction belongs to the other portal");

  const cfg = await configuration();
  // Rebuild the URL as the browser saw it: behind the proxy, req.url's host is internal.
  const current = new URL(redirectUri(portal));
  current.search = search;

  const tokens = await client.authorizationCodeGrant(cfg, current, {
    pkceCodeVerifier: tx.verifier,
    expectedState: tx.state,
    expectedNonce: tx.nonce,
    idTokenExpected: true,
  });
  const c = tokens.claims();
  if (!c) throw new Error("no ID token in the token response");

  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    returnTo: tx.returnTo,
    claims: {
      tid: str(c["tid"]),
      oid: str(c["oid"]),
      name: str(c["name"]) || str(c["preferred_username"]),
      email: str(c["email"]) || str(c["preferred_username"]) || null,
      roles: c["roles"],
    },
  };
}

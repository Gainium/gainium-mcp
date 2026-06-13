# OAuth handoff prompt (run from the main Gainium backend repo)

Paste the block below into an agent started in the repo that owns Gainium user accounts
and API keys (app.gainium.io backend). It does NOT belong in `gainium-mcp` — that repo is
only the MCP resource server.

---

We need to make the hosted Gainium MCP server (`https://mcp.gainium.io/mcp`) eligible for the
Anthropic Claude connector directory. The directory requires **OAuth 2.0** for user-data access
and forbids API-key/bearer creds passed via headers or query params. Today the MCP server
authenticates each request with `X-API-Key` / `X-API-Secret` headers mapped to a Gainium API
key+secret. We must put a real OAuth flow in front of it.

**Your job: build the OAuth 2.1 authorization server, integrated with Gainium accounts.**

Requirements (MCP auth spec + Anthropic directory):

1. **OAuth 2.1 with PKCE** (S256). Authorization code flow.
2. **Dynamic Client Registration** (RFC 7591) at a `/register` endpoint — Claude registers itself
   automatically; we can't pre-register a client.
3. **Authorization Server Metadata** (RFC 8414): serve
   `/.well-known/oauth-authorization-server` with `authorization_endpoint`, `token_endpoint`,
   `registration_endpoint`, supported PKCE methods, scopes, etc.
4. **Redirect URIs:** must allow Claude's callback `https://claude.ai/api/mcp/auth_callback`
   AND Claude Code's localhost loopback redirects on arbitrary ports
   (`http://localhost:<port>/callback` / `http://127.0.0.1:<port>/...`). Loopback ports vary —
   match host+path, ignore the port, per the OAuth native-app spec (RFC 8252).
5. **Consent + account binding:** the `/authorize` flow must (a) authenticate the Gainium user
   (reuse existing app login/session + 2FA), (b) show a consent screen ("Claude wants to access
   your Gainium account"), and (c) on approval, bind the issued token to the user's Gainium API
   credentials. Decide one:
     - mint a dedicated scoped API key for this grant (preferred — revocable, auditable), or
     - let the user pick an existing API key.
   Respect existing per-key restrictions (trading mode / paper-only / allowed bot id) — these are
   already enforced server-side downstream and must carry through.
6. **Scopes:** at minimum a read scope and a write scope, mapping to the API key's permission.
   Default the consent UI to read-only.
7. **Token issuance + introspection/validation:** issue access tokens (JWT or opaque). The MCP
   resource server must be able to validate a token and resolve it to the user's API
   key/secret. Provide either a JWKS endpoint (JWT) or an introspection endpoint (RFC 7662).
8. **No WAF blocking** on the OAuth endpoints (a documented common rejection cause) — make sure
   Cloudflare/WAF allows the `.well-known`, `/authorize`, `/token`, `/register` paths and the
   OAuth callbacks.
9. **Revocation:** user can revoke the Claude grant from Gainium settings (revokes the bound key/token).

Deliverables: the authorization-server endpoints live and reachable, plus a short doc describing
the token format and how the resource server validates a token → (apiKey, apiSecret, restrictions).

Coordinate with the `gainium-mcp` repo, which I'm updating separately to:
  - serve `/.well-known/oauth-protected-resource` (RFC 9728) pointing at this auth server,
  - reject unauthenticated MCP requests with `401` + `WWW-Authenticate: Bearer resource_metadata=...`,
  - replace the `X-API-Key`/`X-API-Secret` header read with Bearer-token validation that resolves
    to the same `(apiKey, apiSecret)` the existing Gainium client code already expects.
Keep the existing local-stdio env-var auth path untouched — OAuth only applies to the hosted endpoint.

Start by discovering this repo's stack (auth/session library, how API keys are minted and stored,
how the web app's login works) and propose the integration design before writing code.

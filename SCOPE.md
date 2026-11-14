# Parlor: scope

Parlor is a lightweight chat client for atproto Spaces. A player signs in with their atproto account over OAuth, finds the spaces they belong to, opens one, and chats. Parlor is generic: it contains no game logic. Its first use is testing Clockwork Conductor (a D&D bot) in Spaces, and development is expected to continue for other uses after that testing is complete.

All Parlor code lives in this repository. Clockwork-specific code, such as the bot reading Parlor messages, lives in the Clockwork Conductor repository.

## Decisions (2026-11-14)

- **Separate project.** Parlor has no Clockwork code or Clockwork concepts in it. MIT license; private GitHub repository `cruftbox/parlor`.
- **Server-side Node app.** A Node server holds each user's OAuth session and makes the Spaces calls; the browser talks only to Parlor's server. Node because Bluesky's official atproto OAuth and Spaces libraries are written for it, and OAuth on the Spaces sandbox was verified with them.
- **Hosting.** Runs on the cruftmanor.com server, at a hostname such as `parlor.cruftmanor.com` (A record plus TLS certificate). Deployed over SSH. This is separate from Clockwork, which still deploys through its own dashboard.
- **Lexicon.** Parlor's message record type and space type are under the `com.cruftmanor.parlor.*` namespace, which needs a `_lexicon` TXT record under cruftmanor.com pointing to the account that publishes the schemas.
- **Target.** Build against the Spaces alpha sandbox (`https://spaces-alpha.host.bsky.network`) now. The public beta starts 2026-12-01 with an updated PDS and an official SDK; expect rework then.
- **Finding a space (blocked, needs a new decision).** Decided: a player enters a space owner's handle, Parlor lists that owner's spaces the player is already a member of, and the player opens one. There are no join requests: in a memberspace only the owner adds members. Sandbox evidence shows this does not work for a newly added member (see Known facts), so a replacement is needed before the space-list UI is built.
- **Owner tools.** The owner of a space can create spaces and add or remove members by handle in Parlor.
- **Chat scope.** Plain text with a length cap; messages ordered by time with the author's handle; updates every few seconds. No editing, deleting, reactions or attachments.
- **Testers.** Anyone with a sandbox account can sign in. Testers must be told the sandbox is shared and unencrypted, and that nothing private belongs there.
- **Clockwork integration.** Clockwork's bot reads Parlor's generic message type and treats messages starting with "DM" as player actions. Parlor does not know about this.

## Known facts from sandbox testing

These come from the Clockwork Spaces assessment (Clockwork repository, `Working Docs/atproto-spaces-assessment-brief.md`) and were verified on the alpha sandbox, 2026-11-12 to 11-14.

- Spaces API names: `authorizeSpaceSync` (credential, about 605 s), `listWriters`, `putMembers` / `removeMembers`, `listSpaces`.
- Discovery gap: after a member was added, that member's `listSpaces` filtered by the owner's DID did not return the space. It appeared only after the member wrote a record there (brief, "Tested on the sandbox 2026-11-13"; `spaces-sandbox-test/run.mjs` test 23).
- OAuth scopes are enforced per collection, space type and management action. Owner tools need `manage=create` and `manage=update`. Production needs hosted `client-metadata.json`; the loopback client used in testing is development-only, and that test used in-memory session stores.
- Reading another member's records needs the space credential, an audience of the repo owner's DID, and an HPKE MAC request (`Accept-Signature`) on `listRepoOps` / `getRecord`.
- Writes into one's own repo are not gated; only the writer set is. A reader must read only repos in `listWriters`. Removal is enforced by the client, not revoked by the PDS: a removed member can keep writing, an existing credential keeps reading until it expires, and later credentials can still read the removed member's old repo. The client must stop reading a repo as soon as `listWriters` reports `repoRemoved`.
- The verified sync loop (`spaces-sandbox-test/python/soak.py`): keep a `listWriters` cursor, process `repoRemoved`, poll each active writer's repo with MAC-verified `listRepoOps`, keep a per-repo revision, sweep all active writers periodically as a safety net, and renew the credential about every nine minutes.
- `deleteSpace` does not remove members' records; each party clears their own.
- OAuth works when the space type has a published declaration found through a `_lexicon` DNS record.
- Measured latency (60-minute soak): write-to-detect p50 2.9 s, p95 5.0 s, with no duplicates, errors or rate limits.

## Unverified

- A hosted, server-side OAuth client with durable sessions for several users, surviving restarts. Only a local loopback client with in-memory stores has been tested.
- What reverse proxy, process manager, ports, users and backups already exist on cruftmanor.com.
- Whether the beta adds a member-discovery mechanism. The beta announcement says nothing about it, so Parlor is not designed on that assumption.

## Risks

- **Server-held OAuth sessions.** A compromise of Parlor's process or session store exposes refresh tokens and DPoP keys for every signed-in user, within their granted scopes.
- **Open to any sandbox account.** Parlor becomes an Internet-facing multi-user service.
- **Shared production server.** Clockwork and its dashboard run on the same host.
- **Alpha-to-beta churn.** Revalidation is certain; the amount of rework is unknown.

## Plan (reviewed with Codex, 2026-11-14)

1. **Discovery decision (gate).** Owner-handle discovery fails for newly added members. Choose a replacement before building the space-list UI. Steps 2 to 5 do not depend on it.
2. **Host inventory, read-only.** On cruftmanor.com: existing reverse proxy, process manager, ports, users, backups and resource limits. Choose the setup to fit what is there.
3. **Lexicons and scope.** The minimal space type declaration, one message collection with its length rule, and the exact OAuth permission set (least privilege; `manage=create` and `manage=update` only for owner tools). Publish the declaration and the `_lexicon` TXT record.
4. **OAuth skeleton at the final hostname.** Hosted client metadata over HTTPS; durable per-user sessions; recovery after restart; logout and token revocation; `HttpOnly`, `Secure` session cookies; CSRF protection on every write and membership change. Verify the scopes, including owner management.
5. **One end-to-end chat slice.** Open a known space, renew credentials, run the verified sync loop, render messages with output escaping, post one message type into the user's own repo.
6. **Owner tools.** Create a space, add and remove members by handle, with tests of the removal behavior described in Known facts.
7. **Before outside testers.** Request-size limits, text validation, rate limits and resource quotas, and a notice on the sign-in page that the sandbox is shared and Spaces content is not end-to-end encrypted. No outside account signs in before this step is done.
8. **Beta revalidation.** After 2026-12-01, recheck discovery, OAuth, method names, credentials, sync, removal and lexicons before treating the alpha code as reusable.

Out of scope until beta: broader UI work, deployment polish, and abstractions around alpha APIs.

## Rules

- Credentials and OAuth session data never enter the repository. Local secrets live in `.env`.
- No passwords, tokens or DPoP keys in logs. Session storage is readable only by Parlor's service user and excluded from backups that leave the server.
- On cruftmanor.com, Parlor runs as its own OS user with its own directories and logs, listens on a loopback-only port behind the reverse proxy, and has resource limits, so it cannot affect Clockwork.

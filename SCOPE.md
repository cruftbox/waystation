# Waystation: scope

Waystation is a lightweight chat client for atproto Spaces. A player signs in with their atproto account over OAuth, finds the spaces they belong to, opens one, and chats. Waystation is generic: it contains no game logic. Its first use is testing Clockwork Conductor (a D&D bot) in Spaces, and development is expected to continue for other uses after that testing is complete.

All Waystation code lives in this repository. Clockwork-specific code, such as the bot reading Waystation messages, lives in the Clockwork Conductor repository.

## Decisions (2026-11-14)

- **Separate project.** Waystation has no Clockwork code or Clockwork concepts in it. MIT license; GitHub repository `cruftbox/waystation`.
- **Name (2026-11-15).** Renamed to Waystation because the earlier name sounded like an existing political social app. The rename moved the hostname, the lexicon NSIDs (`com.cruftmanor.waystation.*`), the server paths and the GitHub repository; spaces created under the earlier NSIDs were not carried over.
- **Server-side Node app.** A Node server holds each user's OAuth session and makes the Spaces calls; the browser talks only to Waystation's server. Node because Bluesky's official atproto OAuth and Spaces libraries are written for it, and OAuth on the Spaces sandbox was verified with them.
- **Hosting.** Runs at `waystation.cruftmanor.com` (A record plus TLS certificate) behind Apache, deployed over SSH. Setup is in DEPLOY.md; facts about the actual server are in `DEPLOY.local.md`, which is not committed.
- **Lexicon.** Space type `com.cruftmanor.waystation.space` and message record `com.cruftmanor.waystation.message` (`text` up to 1000 graphemes, `createdAt`). The schemas are published from the clockworkconductor sandbox account (did:plc:e2fj77s3rygus52me3ul6qka); DNS needs `_lexicon.waystation.cruftmanor.com` TXT `did=did:plc:e2fj77s3rygus52me3ul6qka`.
- **OAuth scopes.** Members: `space:com.cruftmanor.waystation.space?authority=*&collection=com.cruftmanor.waystation.message&collection=com.cruftmanor.waystation.reaction`. Hosts add `space:com.cruftmanor.waystation.space?authority=*&manage=create&manage=update`, chosen at sign-in with a checkbox. `listSpaces` is not used: it needs a read scope over every space type.
- **Target.** Build against the Spaces alpha sandbox (`https://spaces-alpha.host.bsky.network`) now. The public beta starts 2026-12-01 with an updated PDS and an official SDK; expect rework then.
- **Finding a space (revised 2026-11-14).** The first decision (a player enters a space owner's handle and Waystation lists that owner's spaces) does not work for a newly added member (see Known facts). Replacement, decided by the user: Waystation keeps a directory of the spaces created and members added through it, and a member sees those spaces after signing in. Any other space opens from an invite link that the owner copies in Waystation; the link carries the space URI and works only for members. There are no join requests: in a memberspace only the owner adds members.
- **Owner tools.** The owner of a space can create spaces and add or remove members by handle in Waystation.
- **Chat scope.** Plain text with a length cap; messages ordered by time with the author's handle; updates every few seconds. No editing or deleting. Emoji reactions from a fixed palette of 16 (added 2026-11-14).
- **Attachments (added 2026-11-14).** One file per message: PNG, JPEG, GIF or WebP shown inline, or a PDF offered as a download (12 MB cap for both, under the server-wide mod_security request body limit of 12.5 MB, so no filter change). The type is decided by the file's first bytes. Files are stored as blobs in the poster's repo and referenced from the message record; Waystation serves a file only if a message the viewer can currently see references it, fetched with the viewer's space credential (re-issued if older than 10 s), never cached by the browser.
- **Testers.** Anyone with a sandbox account can sign in. Testers must be told the sandbox is shared and unencrypted, and that nothing private belongs there.
- **Clockwork integration.** Clockwork's bot reads Waystation's generic message type and treats messages starting with "DM" as player actions. Waystation does not know about this.

## Known facts from sandbox testing

These come from the Clockwork Spaces assessment and were verified on the alpha sandbox, 2026-11-12 to 11-14.

- Spaces API names: `authorizeSpaceSync` (credential, about 605 s), `listWriters`, `putMembers` / `removeMembers`, `listSpaces`.
- Discovery gap: after a member was added, that member's `listSpaces` filtered by the owner's DID did not return the space. It appeared only after the member wrote a record there (brief, "Tested on the sandbox 2026-11-13"; `spaces-sandbox-test/run.mjs` test 23).
- OAuth scopes are enforced per collection, space type and management action. Owner tools need `manage=create` and `manage=update`. Production needs hosted `client-metadata.json`; the loopback client used in testing is development-only, and that test used in-memory session stores.
- Reading another member's records needs the space credential, an audience of the repo owner's DID, and an HPKE MAC request (`Accept-Signature`) on `listRepoOps` / `getRecord`.
- Writes into one's own repo are not gated; only the writer set is. A reader must read only repos in `listWriters`. Removal is enforced by the client, not revoked by the PDS: a removed member can keep writing, an existing credential keeps reading until it expires, and later credentials can still read the removed member's old repo. The client must stop reading a repo as soon as `listWriters` reports `repoRemoved`.
- The verified sync loop (`spaces-sandbox-test/python/soak.py`): keep a `listWriters` cursor, process `repoRemoved`, poll each active writer's repo with MAC-verified `listRepoOps`, keep a per-repo revision, sweep all active writers periodically as a safety net, and renew the credential about every nine minutes.
- `deleteSpace` does not remove members' records; each party clears their own.
- OAuth works when the space type has a published declaration found through a `_lexicon` DNS record.
- Measured latency (60-minute soak): write-to-detect p50 2.9 s, p95 5.0 s, with no duplicates, errors or rate limits.

Found while building (2026-11-14):

- A loopback OAuth client must declare every requested scope in its metadata; a request for a scope not declared fails with `invalid_scope`.
- `listSpaces` through OAuth needs `space:*?authority=<own DID>&action=read_self`.
- `authorizeSpaceSync` for a deleted space returns 400 `SpaceDeleted`.

## Unverified

- Whether the beta adds a member-discovery mechanism. The beta announcement says nothing about it, so Waystation is not designed on that assumption.

## Risks

- **Alpha-to-beta churn.** Revalidation is certain; the amount of rework is unknown.
- Deployment risks are tracked in `DEPLOY.local.md`, which is not committed.

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

## Progress (2026-11-14)

1. Done. Directory plus invite links (user decision).
2. Done. Inventory recorded in `DEPLOY.local.md`.
3. Done. Lexicons in `lexicons/`, published to the sandbox; `_lexicon.waystation.cruftmanor.com` TXT record live.
4. Done. Live at https://waystation.cruftmanor.com (Apache proxy to the systemd service on 127.0.0.1:8791, Let's Encrypt certificate via acme.sh). 25/25 end-to-end checks pass against the hosted client with the production namespace.
5. Done. 25/25 end-to-end checks against the sandbox (`npm run e2e`): sign-in with both scopes, CSRF, create, add, discovery, open by link, post, read (about 0.5 to 0.7 s to see the other user's message), plain-text rendering, removal (messages hidden within about 2 s, removed member refused), sign-out.
6. Done (same test).
7. Done in code (size, rate and count limits, sandbox notice). Codex reviewed the code and found 10 issues (1 high, 5 medium, 4 low); all were fixed. Outside testers can sign in.
8. After 2026-12-01.
9. Attachments done. 40/40 end-to-end checks on the hosted site, including a PDF near the 12 MB cap through Apache and mod_security. Codex review: three findings (download slot released before sending, stale credential on downloads, browser cache shared across accounts) fixed; the 10 s credential window is a deliberate trade-off.
10. Image thumbnails (2026-11-14). The poster's browser draws PNG, JPEG and WebP images at 720 pixels on the long side and uploads that copy (WebP, or JPEG where the browser cannot write WebP; at most 256 KB) with the image's width and height. The chat shows the thumbnail in a box sized before it loads, with the file name and full size below; clicking opens the full file. GIFs and images already small enough get no thumbnail. Older messages show the full image. The thumbnail is served under the same rule as the file. The message lexicon gained optional `thumb`, `width` and `height` and was republished. 46/46 end-to-end checks.
11. Image preview before sending, and drag and drop onto the open chat (2026-11-14).
12. Reactions (2026-11-14). Record `com.cruftmanor.waystation.reaction` (`subject` = Waystation message URI, `emoji`, `createdAt`) in the reacting member's repo; removing a reaction deletes the record. Palette of 16: 👍 👎 ❤️ 😂 😮 😢 😡 🎉 🔥 💯 🎲 ⚔️ 🛡️ 💀 🐉 💰 (matched with or without U+FE0F). Counted once per author, emoji and message; only from current writers, only on shown messages. Chips under each message (yours highlighted, names on hover), "+" opens the palette. The space declaration now lists both collections. A probe showed the sandbox does not check the declaration's collection list on writes, so spaces created before the change take reactions. The sign-in scope gained the reaction collection, so existing sign-ins must sign in again to react. 57/57 end-to-end checks.

## Open items (2026-11-14)

- **Hosted e2e can sign the owner out.** A new sign-in whose host checkbox differs ends that account's web sessions of the other scope, so `npm run e2e` against the hosted site (signs in as the owner with host scope) can sign the owner out elsewhere. Run e2e against a local server.
- **Test-namespace lexicons.** `com.cruftbox.clockwork.waystationspace` and `.waystationmessage` stay published on the sandbox bot account because the local `.env` uses them (see README). They go away with the alpha.
- **Space deleted outside Waystation.** Its entry stays in the owner's list until clicked; opening it then removes it.
- **Beta revalidation** (plan step 8): lexicons and the `_lexicon.waystation.cruftmanor.com` record point at the sandbox bot account, which ends with the alpha.

## Future work

- None listed.

## Rules

- Credentials and OAuth session data never enter the repository. Local secrets live in `.env`.
- No passwords, tokens or DPoP keys in logs. Session storage is readable only by Waystation's service user and excluded from backups that leave the server.
- On its server, Waystation runs as its own OS user with its own directories and logs, listens on a loopback-only port behind the reverse proxy, and has resource limits, so it cannot affect other services on the host.

# Parlor

A lightweight chat client for atproto Spaces. People sign in with their atproto account over OAuth, see the spaces they host or were added to, open one, and chat. Hosts create spaces and add or remove members by handle. Parlor holds no game logic; its first use is testing Clockwork Conductor in Spaces.

Status: works against the Spaces alpha sandbox. Spaces enters public beta on 2026-12-01; expect changes. See [SCOPE.md](SCOPE.md) for decisions and plan, and [DEPLOY.md](DEPLOY.md) for the server setup.

## How it works

The browser talks only to the Parlor server. The server keeps each user's OAuth session (encrypted at rest, with the key on the same server) and makes the Spaces calls for them. The operator of a Parlor server can therefore read any space its signed-in users belong to; `/privacy` says so to users.

How each part works:

- **Reading**: per user and space, Parlor gets a space credential (delegation token from the user's PDS, then `authorizeSpaceSync` at the space host), follows `listWriters` with a cursor, and reads each current writer's repo with MAC-verified `listRepoOps`. It sweeps all writers every minute and re-authorizes then, so a removed member loses access within a minute. Messages live in memory only.
- **Posting**: a `com.cruftmanor.parlor.message` record (`text`, `createdAt`) in the poster's own repo in the space, after a fresh membership check.
- **Finding spaces**: Parlor keeps a directory of spaces created and members added through it. A member sees those spaces after signing in. Any other space opens from an invite link (`/?invite=<space URI>`), which works only for members.
- **Active members**: each space shows a list of members who have posted or reacted, taken from the view's `listWriters` set. Members who were added but never wrote, and removed members, do not appear. Every member sees it, not only the owner.
- **Theme**: System, Light or Dark, picked in the header. `public/theme.js` loads before first paint, sets `data-theme` on `<html>`, and remembers the choice in `localStorage`. Without a choice the OS setting applies.
- **About and privacy**: `/about` (who runs it) and `/privacy` (what the operator and the Spaces servers can read, and what Parlor stores) are static pages in `public/`.
- **Scopes**: members grant `space:<type>?authority=*&collection=<message>&collection=<reaction>`. Hosts also grant `space:<type>?authority=*&manage=create&manage=update`.

Messages are shown in `createdAt` order (author-supplied), with author DID and record key as tie-breakers.

## Lexicons

`lexicons/space.json` (space type declaration), `lexicons/message.json` (message record) and `lexicons/reaction.json` (reaction record). The declaration must be published as a `com.atproto.lexicon.schema` record, and DNS must carry `_lexicon.<authority>` pointing at the publishing DID, or OAuth sign-in fails. `npm run publish-lexicons` publishes both (see the script header for environment variables).

## Development

Requires Node 22.13 or later (uses `node:sqlite`).

    npm install
    cp .env.example .env     # set SESSION_KEY; PUBLIC_URL=http://127.0.0.1:8790 uses the loopback OAuth client
    npm start
    npm test                 # unit tests
    npm run e2e              # end-to-end against the sandbox; needs two sandbox accounts and Edge or Chrome

With a loopback `PUBLIC_URL`, the space type's declaration must already resolve. Tests on 2026-11-14 used `SPACE_TYPE=com.cruftbox.clockwork.parlorspace`, `MESSAGE_COLLECTION=com.cruftbox.clockwork.parlormessage` and `REACTION_COLLECTION=com.cruftbox.clockwork.parlorreaction`, whose declarations resolve through the existing `_lexicon.clockwork.cruftbox.com` record.

## License

MIT

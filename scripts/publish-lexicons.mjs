// Publishes Waystation's lexicons as com.atproto.lexicon.schema records in the
// publishing account's repo (rkey = NSID). The OAuth server reads the space
// declaration to show it on the consent screen; without it sign-in fails.
// DNS must also have TXT _lexicon.<authority domain> = "did=<publisher DID>".
//
// Env: PDS_URL, PUBLISHER_HANDLE, PUBLISHER_APP_PASSWORD,
//      SPACE_TYPE, MESSAGE_COLLECTION, REACTION_COLLECTION (defaults: com.cruftmanor.waystation.*)
// Usage: node scripts/publish-lexicons.mjs [--dry-run]

import { readFileSync } from 'node:fs'

const env = process.env
const PDS = (env.PDS_URL ?? '').replace(/\/$/, '')
const SPACE_TYPE = env.SPACE_TYPE ?? 'com.cruftmanor.waystation.space'
const MESSAGE = env.MESSAGE_COLLECTION ?? 'com.cruftmanor.waystation.message'
const REACTION = env.REACTION_COLLECTION ?? 'com.cruftmanor.waystation.reaction'
const DRY = process.argv.includes('--dry-run')

function load(file, id, replacements) {
  let text = readFileSync(new URL(`../lexicons/${file}`, import.meta.url), 'utf8')
  for (const [a, b] of Object.entries(replacements)) text = text.split(a).join(b)
  const lex = JSON.parse(text)
  lex.id = id
  return lex
}

const subs = {
  'com.cruftmanor.waystation.space': SPACE_TYPE,
  'com.cruftmanor.waystation.message': MESSAGE,
  'com.cruftmanor.waystation.reaction': REACTION,
}
const docs = [
  load('space.json', SPACE_TYPE, subs),
  load('message.json', MESSAGE, subs),
  load('reaction.json', REACTION, subs),
]

if (DRY) {
  console.log(JSON.stringify(docs, null, 2))
  process.exit(0)
}
if (!PDS || !env.PUBLISHER_HANDLE || !env.PUBLISHER_APP_PASSWORD) {
  console.error('PDS_URL, PUBLISHER_HANDLE and PUBLISHER_APP_PASSWORD are required')
  process.exit(1)
}

async function xrpc(method, body, jwt) {
  const res = await fetch(`${PDS}/xrpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${out.error ?? ''} ${out.message ?? ''}`)
  return out
}

const s = await xrpc('com.atproto.server.createSession', {
  identifier: env.PUBLISHER_HANDLE, password: env.PUBLISHER_APP_PASSWORD,
})
for (const doc of docs) {
  const r = await xrpc('com.atproto.repo.putRecord', {
    repo: s.did, collection: 'com.atproto.lexicon.schema', rkey: doc.id,
    record: { $type: 'com.atproto.lexicon.schema', ...doc },
  }, s.accessJwt)
  console.log(`published ${doc.id} -> ${r.uri}`)
}
console.log(`DNS: TXT _lexicon.${SPACE_TYPE.split('.').slice(0, -1).reverse().join('.')} "did=${s.did}"`)

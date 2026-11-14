// Spaces protocol calls. Two kinds:
//  - calls made as the user through their OAuth session (delegation token,
//    createRecord, createSpace, member management, listSpaces);
//  - credential calls to a space host or repo host (authorizeSpaceSync,
//    listWriters, listRepoOps), signed with a per-view keypair.
//
// SpaceView holds one user's read state for one space: a credential, the
// listWriters cursor, per-repo revisions and the messages seen. It follows
// the sync loop verified on the alpha sandbox (soak test, 2026-11-13).

import { P256Keypair } from '@atproto/crypto'
import {
  COMMIT_MAC_PROFILE,
  createSpaceSigHeaders,
  encapsulate,
  formatMacRequest,
  parseSpaceToken,
  verifyCommitMac,
} from '@atproto/space'
import { config } from './config.js'
import { pdsFor, resolveDid, forgetDid } from './identity.js'
import { safeFetch, checkUrl, MAX_RESPONSE_BYTES } from './net.js'
import { attachmentFromRecord } from './files.js'

const TIMEOUT_MS = 15000
const MAX_WRITERS = 200
const READ_CONCURRENCY = 4
const FUTURE_SLACK_MS = 5 * 60 * 1000

export class XrpcError extends Error {
  constructor(method, status, body) {
    super(`${method}: HTTP ${status}${body?.error ? ` ${body.error}` : ''}${body?.message ? `: ${body.message}` : ''}`)
    this.method = method
    this.status = status
    this.error = body?.error
  }
}

// Read a fetch Response body with a size cap.
async function readCapped(res, maxBytes = MAX_RESPONSE_BYTES) {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('response too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// res is a fetch Response (OAuth fetchHandler) or a safeFetch result.
async function parse(method, res) {
  const text = typeof res.text === 'string' ? res.text : await readCapped(res)
  let body = {}
  if (text) {
    try { body = JSON.parse(text) } catch { body = { error: 'BadResponse', message: text.slice(0, 200) } }
  }
  if (!res.ok) throw new XrpcError(method, res.status, body)
  return { body, headers: res.headers }
}

function qs(query) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

// ---------- calls as the user (OAuth session, user's own PDS) ----------

export async function asUser(session, method, { query, body } = {}) {
  const res = await session.fetchHandler(`/xrpc/${method}${qs(query)}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return (await parse(method, res)).body
}

// ---------- unauthenticated or credential calls to another host ----------

async function hostCall(host, method, { query, body, headers = {} } = {}) {
  const res = await safeFetch(`${host}/xrpc/${method}${qs(query)}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
    timeoutMs: TIMEOUT_MS,
  })
  return parse(method, res)
}

// at://<authority DID>/space/<type>/<skey>
export function parseSpaceUri(uri) {
  const m = /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+)\/space\/([a-zA-Z0-9.-]+)\/([a-zA-Z0-9._~:-]{1,512})$/.exec(String(uri ?? ''))
  if (!m) return null
  return { uri: m[0], authority: m[1], spaceType: m[2], skey: m[3] }
}

// ---------- message records ----------

function cleanText(s, max) {
  if (typeof s !== 'string') return null
  // Drop control characters except newline and tab.
  const t = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim()
  if (!t) return null
  const cps = [...t]
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : t
}

function cleanDate(s) {
  const d = typeof s === 'string' ? Date.parse(s) : NaN
  return Number.isFinite(d) ? new Date(d).toISOString() : null
}

// A message needs text, an attachment, or both. An attachment that fails
// validation is dropped; the message then needs text to be shown.
export function messageFromRecord(value, max = config.maxMessageLength) {
  if (!value || typeof value !== 'object') return null
  const text = cleanText(value.text, max)
  const attachment = attachmentFromRecord(value.attachment)
  if (!text && !attachment) return null
  return { text: text ?? '', createdAt: cleanDate(value.createdAt), attachment }
}

// Display order: createdAt, then author DID, then rkey. createdAt is
// author-supplied, so this is presentation order, not proof of sequence.
export function compareMessages(a, b) {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
    : a.author < b.author ? -1 : a.author > b.author ? 1
    : a.rkey < b.rkey ? -1 : a.rkey > b.rkey ? 1 : 0
}

// ---------- SpaceView ----------

export class SpaceView {
  constructor({ session, space }) {
    this.session = session
    this.space = space // parsed
    this.cred = null // { token, keypair, exp }
    this.cursor = undefined
    this.writers = new Set()
    this.since = new Map() // repo -> rev
    this.messages = new Map() // `${repo}/${rkey}` -> message
    this.version = 0
    this.lastSync = 0
    this.lastSweep = 0
    this.lastUsed = Date.now()
    this.syncing = null
    this.error = null
    this.seq = 0 // arrival counter, for trimming
    this.tooManyWriters = false
  }

  async credential() {
    if (this.cred && this.cred.exp - 60 > Date.now() / 1000) return this.cred
    const dt = await asUser(this.session, 'com.atproto.space.getDelegationToken', {
      query: { space: this.space.uri },
    })
    const keypair = await P256Keypair.create()
    const host = await pdsFor(this.space.authority)
    const { body } = await hostCall(host, 'com.atproto.space.authorizeSpaceSync', {
      body: { space: this.space.uri, credentialKey: keypair.did(), delegationToken: dt.token },
    })
    const { exp } = parseSpaceToken('credential', body.credential).payload
    this.cred = { token: body.credential, keypair, exp, issuedAt: Date.now() }
    return this.cred
  }

  async signed(audience) {
    const c = await this.credential()
    const { headers } = await createSpaceSigHeaders({
      authorization: `Atproto-Space-Credential ${c.token}`,
      audience,
      keypair: c.keypair,
    })
    return headers
  }

  // Page through listWriters from the cursor. Returns repos with new writes.
  async pollWriters() {
    const host = await pdsFor(this.space.authority)
    const dirty = new Set()
    for (let page = 0; page < 20; page++) {
      const { body } = await hostCall(host, 'com.atproto.space.listWriters', {
        query: { space: this.space.uri, cursor: this.cursor },
        headers: await this.signed(this.space.authority),
      })
      const repos = body.repos ?? []
      for (const w of repos) {
        const did = w.repo ?? w.did
        if (!did) continue
        if (String(w.$type ?? '').endsWith('repoRemoved')) {
          // Removal is enforced here: stop reading the repo and hide its
          // messages. The PDS would still serve them.
          if (this.writers.delete(did) || this.since.has(did)) this.dropRepo(did)
          // If the viewer was removed, drop the credential so the next call
          // has to re-authorize (and fails).
          if (did === this.session.did) this.cred = null
          continue
        }
        if (!this.writers.has(did) && this.writers.size >= MAX_WRITERS) {
          this.tooManyWriters = true
          continue
        }
        this.writers.add(did)
        dirty.add(did)
      }
      if (body.cursor) this.cursor = body.cursor
      if (repos.length === 0 || !body.cursor) break
    }
    return dirty
  }

  dropRepo(did) {
    this.since.delete(did)
    for (const k of [...this.messages.keys()]) {
      if (k.startsWith(`${did}/`)) this.messages.delete(k)
    }
    this.version++
  }

  // listRepoOps with a commit MAC request; retries once with a re-resolved
  // KEM key on MAC failure. Throws if the MAC cannot be verified.
  async repoOps(repo, since) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const doc = await resolveDid(repo)
      if (!doc.kemKey) throw new Error(`${repo} has no #atproto_kem key`)
      const enc = await encapsulate(doc.kemKey)
      const host = doc.pds
      const { body, headers } = await hostCall(host, 'com.atproto.space.listRepoOps', {
        query: { space: this.space.uri, repo, since, limit: 100 },
        headers: {
          ...(await this.signed(repo)),
          'accept-signature': formatMacRequest(COMMIT_MAC_PROFILE, enc.keyShare),
        },
      })
      try {
        const commit = { ...body.commit }
        if (commit.data?.$bytes !== undefined) {
          commit.data = new Uint8Array(Buffer.from(commit.data.$bytes, 'base64'))
        }
        verifyCommitMac(commit, { ...enc, headers })
        return body.ops ?? []
      } catch (err) {
        if (attempt === 0) {
          forgetDid(repo)
          continue
        }
        throw new Error(`MAC verification failed for ${repo}: ${err.message}`)
      }
    }
    return []
  }

  applyOps(repo, ops) {
    let changed = false
    for (const op of ops) {
      if (op.rev && (!this.since.get(repo) || op.rev > this.since.get(repo))) this.since.set(repo, op.rev)
      if (op.collection !== config.messageCollection) continue
      const key = `${repo}/${op.rkey}`
      if (op.cid == null) {
        changed = this.messages.delete(key) || changed
        continue
      }
      const m = messageFromRecord(op.value)
      if (!m) continue
      // createdAt is author-supplied. Clamp future dates to the time seen,
      // so a writer cannot pin messages to the end of the list.
      const seenAt = new Date().toISOString()
      const createdAt = !m.createdAt || Date.parse(m.createdAt) > Date.now() + FUTURE_SLACK_MS ? seenAt : m.createdAt
      this.messages.set(key, {
        seq: this.seq++,
        uri: `at://${repo}/${op.collection}/${op.rkey}`,
        author: repo,
        rkey: op.rkey,
        text: m.text,
        attachment: m.attachment,
        createdAt,
      })
      changed = true
    }
    if (this.messages.size > config.maxMessagesPerView) {
      // Trim in arrival order, not createdAt order, so back- or
      // forward-dated records cannot push out messages that arrived later.
      const sorted = [...this.messages.entries()].sort((a, b) => a[1].seq - b[1].seq)
      for (const [k] of sorted.slice(0, this.messages.size - config.maxMessagesPerView)) this.messages.delete(k)
    }
    if (changed) this.version++
  }

  async readRepo(repo) {
    // Page until a short page; listRepoOps returns up to `limit` ops.
    for (let page = 0; page < 50; page++) {
      const ops = await this.repoOps(repo, this.since.get(repo))
      if (!this.writers.has(repo)) return // removed meanwhile
      this.applyOps(repo, ops)
      if (ops.length < 100) return
    }
  }

  async syncNow() {
    const now = Date.now()
    const sweep = now - this.lastSweep >= config.fullSweepSeconds * 1000
    // An existing credential keeps working after the viewer is removed
    // (until it expires, about 10 minutes). Re-authorizing on each sweep
    // bounds how long a removed member can keep reading through Parlor.
    if (sweep && this.lastSweep) this.cred = null
    if (sweep) this.lastSweep = now
    const dirty = await this.pollWriters()
    const repos = sweep ? [...this.writers] : [...dirty].filter((d) => this.writers.has(d))
    // Read at most READ_CONCURRENCY repos at a time.
    const failed = []
    for (let i = 0; i < repos.length; i += READ_CONCURRENCY) {
      const batch = await Promise.allSettled(repos.slice(i, i + READ_CONCURRENCY).map((r) => this.readRepo(r)))
      for (const r of batch) if (r.status === 'rejected') failed.push(r.reason)
    }
    this.error = failed.length ? failed[0].message : null
    this.lastSync = Date.now()
  }

  // Sync unless one ran within minSyncSeconds; concurrent callers share one.
  async sync() {
    this.lastUsed = Date.now()
    if (Date.now() - this.lastSync < config.minSyncSeconds * 1000) return
    if (!this.syncing) {
      this.syncing = this.syncNow().finally(() => { this.syncing = null })
    }
    await this.syncing
  }

  list() {
    return [...this.messages.values()].sort(compareMessages)
  }

  // The file with this CID (an attachment or its thumbnail) on a message by
  // this author that the view currently shows, as { mime, size, name, thumb },
  // or null. Serving only these keeps file access tied to what the viewer
  // can read in this space.
  findFile(repo, cid) {
    for (const m of this.messages.values()) {
      const a = m.author === repo ? m.attachment : null
      if (!a) continue
      if (a.cid === cid) return { mime: a.mime, size: a.size, name: a.name, thumb: false }
      if (a.thumb?.cid === cid) return { mime: a.thumb.mime, size: a.thumb.size, name: a.name, thumb: true }
    }
    return null
  }

  // Download a blob from the author's repo host with this view's credential.
  async fetchBlob(repo, cid, maxBytes) {
    const doc = await resolveDid(repo)
    if (!doc.pds) throw new Error(`${repo} has no PDS endpoint`)
    checkUrl(doc.pds)
    const method = 'com.atproto.space.getBlob'
    const res = await safeFetch(`${doc.pds}/xrpc/${method}${qs({ space: this.space.uri, repo, cid })}`, {
      headers: await this.signed(repo),
      timeoutMs: 60000,
      maxBytes,
      binary: true,
    })
    if (!res.ok) await parse(method, res) // throws XrpcError
    return res.buffer
  }
}

// ---------- user-side operations ----------

// attachment: { blob, name, thumb?, width?, height? } where blob and thumb
// are refs returned by uploadBlob.
export async function postMessage(session, space, text, attachment = null) {
  const record = { $type: config.messageCollection, text, createdAt: new Date().toISOString() }
  if (attachment) {
    record.attachment = { file: attachment.blob, name: attachment.name }
    if (attachment.thumb) record.attachment.thumb = attachment.thumb
    if (attachment.width && attachment.height) {
      record.attachment.width = attachment.width
      record.attachment.height = attachment.height
    }
  }
  return asUser(session, 'com.atproto.space.createRecord', {
    body: { space: space.uri, repo: session.did, collection: config.messageCollection, record },
  })
}

// Upload a file to the user's own repo host. The file stays unattached (and
// is eventually discarded by the host) until a record refers to it.
export async function uploadBlob(session, bytes, mime) {
  const method = 'com.atproto.repo.uploadBlob'
  const res = await session.fetchHandler(`/xrpc/${method}`, {
    method: 'POST',
    headers: { 'content-type': mime },
    body: bytes,
  })
  const { body } = await parse(method, res)
  if (!body.blob?.ref?.$link) throw new XrpcError(method, 502, { error: 'BadResponse' })
  return body.blob
}

export async function createSpace(session) {
  const body = await asUser(session, 'com.atproto.space.createSpace', {
    body: {
      spaceType: config.spaceType,
      policy: { $type: 'com.atproto.memberspace.policy', publicRead: false },
    },
  })
  return body.space
}

export async function listMembers(session, space) {
  const body = await asUser(session, 'com.atproto.memberspace.listMembers', { query: { space: space.uri } })
  return body.members ?? []
}

export async function addMember(session, space, did) {
  await asUser(session, 'com.atproto.memberspace.putMembers', {
    body: { space: space.uri, members: [{ did, read: true, write: true }] },
  })
}

export async function removeMember(session, space, did) {
  await asUser(session, 'com.atproto.memberspace.removeMembers', {
    body: { space: space.uri, dids: [did] },
  })
}

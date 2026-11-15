// Waystation HTTP server. The browser talks only to this server; this server
// holds each user's OAuth session and talks to atproto hosts.

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config, isLoopback } from './config.js'
import { openDb, makeCipher, purgeExpired } from './db.js'
import { makeOAuthClient, clientMetadata, scopes, callbackPath, canUpload, canReact } from './oauth.js'
import { resolveHandle, displayHandle, isDid, sweepCaches } from './identity.js'
import {
  SpaceView, XrpcError, parseSpaceUri, postMessage, uploadBlob, addReaction, deleteReaction, paletteEmoji, REACTION_EMOJI, createSpace, listMembers, addMember, removeMember,
} from './spaces.js'
import { sniffMime, maxBytesFor, maxFileBytes, cleanFileName, isImage, contentDisposition, THUMB_TYPES, MAX_DIMENSION } from './files.js'
import { RateLimiter, RateLimitError } from './ratelimit.js'

const log = (...a) => console.log(new Date().toISOString(), ...a)

if (!config.sessionKey) {
  console.error('SESSION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  process.exit(1)
}

const db = openDb(config.dbPath)
const cipher = makeCipher(config.sessionKey)
const oauth = makeOAuthClient(db, cipher)
const limiter = new RateLimiter()
const secure = config.publicUrl.startsWith('https://')
const publicOrigin = new URL(config.publicUrl).origin

// ---------- static files ----------

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
  '/about': ['about.html', 'text/html; charset=utf-8'],
}
const staticCache = new Map()
function staticFile(name) {
  if (!staticCache.has(name) || isLoopback) staticCache.set(name, readFileSync(PUBLIC + name))
  return staticCache.get(name)
}

// ---------- helpers ----------

// Errors whose message is safe to show to the user.
class UserFacingError extends Error {}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; "
    + "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-store')
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function redirect(res, location) {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.setHeader('Cache-Control', 'no-store')
  res.end()
}

function parseCookies(req) {
  const out = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function cookie(name, value, { maxAge, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax']
  if (secure) parts.push('Secure')
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`)
  return parts.join('; ')
}

const MAX_BODY = 16 * 1024
async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'UnsupportedMediaType')
  }
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'PayloadTooLarge')
    chunks.push(chunk)
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error()
    return v
  } catch {
    throw new HttpError(400, 'BadJson')
  }
}

// multipart/form-data upload, read whole with a cap (largest file plus room
// for the other fields), then parsed by the built-in form parser.
async function readForm(req) {
  const type = String(req.headers['content-type'] ?? '')
  if (!type.startsWith('multipart/form-data')) throw new HttpError(415, 'UnsupportedMediaType')
  const cap = maxFileBytes() + config.maxThumbBytes + 64 * 1024
  if (Number(req.headers['content-length'] ?? 0) > cap) throw new HttpError(413, 'FileTooLarge', tooLargeMessage())
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) throw new HttpError(413, 'FileTooLarge', tooLargeMessage())
    chunks.push(chunk)
  }
  try {
    return await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData()
  } catch {
    throw new HttpError(400, 'BadForm')
  }
}

const mb = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`
function tooLargeMessage() {
  return `Images are limited to ${mb(config.maxImageBytes)} and PDFs to ${mb(config.maxPdfBytes)}.`
}

function fileUrl(uri, repo, cid) {
  return `/api/space/file?${new URLSearchParams({ uri, repo, cid })}`
}

// Optional fields sent with an image: a thumbnail made by the browser and
// the image's width and height. A bad thumbnail is refused; bad or missing
// sizes are ignored.
async function thumbFromForm(form) {
  const out = {}
  const t = form.get('thumb')
  if (t && typeof t !== 'string') {
    const bytes = Buffer.from(await t.arrayBuffer())
    const mime = sniffMime(bytes)
    if (!THUMB_TYPES.includes(mime)) throw new HttpError(415, 'BadThumb', 'The image preview is not a WebP, JPEG or PNG.')
    if (bytes.length > config.maxThumbBytes) throw new HttpError(413, 'ThumbTooLarge', 'The image preview is too large.')
    out.thumb = { bytes, mime }
  }
  const w = Number(form.get('width'))
  const h = Number(form.get('height'))
  const ok = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION
  if (ok(w) && ok(h)) Object.assign(out, { width: w, height: h })
  return out
}

// File transfers held in memory at once, server-wide.
const MAX_UPLOADS_IN_FLIGHT = 2
const MAX_DOWNLOADS_IN_FLIGHT = 6
const FILE_CRED_MAX_AGE_MS = 10000
// Names listed per reaction (shown on hover).
const MAX_REACTOR_NAMES = 20
const inFlight = { upload: 0, download: 0 }
async function withSlot(kind, max, fn) {
  if (inFlight[kind] >= max) throw new HttpError(503, 'Busy', 'Waystation is busy with other files; try again shortly.')
  inFlight[kind]++
  try {
    return await fn()
  } finally {
    inFlight[kind]--
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const token = () => randomBytes(32).toString('base64url')

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function clientIp(req) {
  // Behind Apache on loopback: trust X-Forwarded-For's last hop only then.
  const remote = req.socket.remoteAddress ?? ''
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if ((remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && fwd.length) return fwd[fwd.length - 1]
  return remote
}

// ---------- web sessions ----------

const qSessionGet = db.prepare('SELECT did, csrf, expires, host FROM web_session WHERE sid_hash = ?')
const qSessionPut = db.prepare('INSERT INTO web_session (sid_hash, did, csrf, created, expires, host) VALUES (?, ?, ?, ?, ?, ?)')
const qSessionTrim = db.prepare(`DELETE FROM web_session WHERE did = ? AND sid_hash NOT IN
  (SELECT sid_hash FROM web_session WHERE did = ? ORDER BY created DESC LIMIT 9)`)
// A new sign-in replaces the DID's OAuth session. Web sessions created with
// a different scope must not inherit it, so they are ended.
const qSessionDelOtherScope = db.prepare('DELETE FROM web_session WHERE did = ? AND host != ?')
const qSessionDel = db.prepare('DELETE FROM web_session WHERE sid_hash = ?')
const qSessionLive = db.prepare('SELECT COUNT(*) AS n FROM web_session WHERE did = ? AND expires > ?')

function getWebSession(req) {
  const sid = parseCookies(req).waystation_sid
  if (!sid) return null
  const row = qSessionGet.get(sha256(sid))
  if (!row || row.expires < Date.now()) return null
  return { sidHash: sha256(sid), did: row.did, csrf: row.csrf, host: row.host === 1 }
}

async function requireUser(req) {
  const ws = getWebSession(req)
  if (!ws) throw new HttpError(401, 'NotSignedIn')
  limiter.hit(`req:${ws.did}`, config.requestsPerMinute)
  let session
  try {
    session = await oauth.restore(ws.did)
  } catch (err) {
    qSessionDel.run(ws.sidHash)
    log('restore failed', ws.did, err.message)
    throw new HttpError(401, 'SessionExpired', 'Your sign-in has expired. Please sign in again.')
  }
  return { ws, session }
}

function requireCsrf(req, ws) {
  const origin = req.headers.origin
  if (origin && origin !== publicOrigin) throw new HttpError(403, 'BadOrigin')
  if (!safeEqual(req.headers['x-csrf-token'] ?? '', ws.csrf)) throw new HttpError(403, 'BadCsrf')
}

async function grantedScope(session) {
  try {
    const info = await session.getTokenInfo(false)
    return String(info.scope ?? '')
  } catch {
    return ''
  }
}

async function requireOwnerScope(session, ws) {
  const scope = await grantedScope(session)
  if (!ws.host || !scope.includes('manage=create') || !scope.includes('manage=update')) {
    throw new HttpError(403, 'NeedOwnerSignIn', 'Sign in again with "I want to host spaces" checked.')
  }
}

// ---------- directory ----------

const q = {
  spaceGet: db.prepare('SELECT uri, owner_did, name FROM space WHERE uri = ?'),
  spacePut: db.prepare('INSERT OR IGNORE INTO space (uri, owner_did, name, created) VALUES (?, ?, ?, ?)'),
  spacesOwned: db.prepare('SELECT uri, name FROM space WHERE owner_did = ? ORDER BY created'),
  spacesOwnedCount: db.prepare('SELECT COUNT(*) AS n FROM space WHERE owner_did = ?'),
  memberPut: db.prepare('INSERT OR REPLACE INTO space_member (uri, did, handle, added) VALUES (?, ?, ?, ?)'),
  memberDel: db.prepare('DELETE FROM space_member WHERE uri = ? AND did = ?'),
  spacesMember: db.prepare(`SELECT s.uri, s.name, s.owner_did FROM space_member m JOIN space s ON s.uri = m.uri
                            WHERE m.did = ? ORDER BY s.created`),
  openedPut: db.prepare('INSERT OR REPLACE INTO opened_space (did, uri, name, opened) VALUES (?, ?, ?, ?)'),
  openedList: db.prepare('SELECT uri, name FROM opened_space WHERE did = ? ORDER BY opened DESC'),
  openedDel: db.prepare('DELETE FROM opened_space WHERE did = ? AND uri = ?'),
  openedTrim: db.prepare(`DELETE FROM opened_space WHERE did = ? AND uri NOT IN
    (SELECT uri FROM opened_space WHERE did = ? ORDER BY opened DESC LIMIT 50)`),
}

function cleanName(s) {
  const t = String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 80)
  return t
}

// The space is gone: remove it from the directory for everyone.
function forgetSpace(uri) {
  db.prepare('DELETE FROM space_member WHERE uri = ?').run(uri)
  db.prepare('DELETE FROM opened_space WHERE uri = ?').run(uri)
  db.prepare('DELETE FROM space WHERE uri = ?').run(uri)
}

function spaceName(uri) {
  return q.spaceGet.get(uri)?.name ?? null
}

// ---------- space views ----------

const MAX_MEMBERS = 50
const views = new Map() // `${did} ${uri}` -> SpaceView
const MAX_VIEWS = 300

function viewFor(session, space) {
  const key = `${session.did} ${space.uri}`
  let v = views.get(key)
  if (!v) {
    if (views.size >= MAX_VIEWS) evictViews(true)
    if (views.size >= MAX_VIEWS) throw new HttpError(503, 'Busy', 'Too many open spaces; try again shortly.')
    v = new SpaceView({ session, space })
    views.set(key, v)
  }
  v.session = session // refreshed session object
  return v
}

function evictViews(force = false) {
  const idle = config.viewIdleMinutes * 60 * 1000
  const now = Date.now()
  const entries = [...views.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [k, v] of entries) {
    if (now - v.lastUsed > idle || (force && views.size >= MAX_VIEWS)) views.delete(k)
  }
}

function dropViewsForDid(did) {
  for (const k of [...views.keys()]) if (k.startsWith(`${did} `)) views.delete(k)
}

function spaceFromInput(input) {
  let s = String(input ?? '').trim()
  // Accept an invite link or a bare space URI.
  try {
    if (s.startsWith('http')) s = new URL(s).searchParams.get('invite') ?? ''
  } catch { s = '' }
  const space = parseSpaceUri(s)
  if (!space) throw new HttpError(400, 'BadSpace', 'That is not a space link or space URI.')
  if (space.spaceType !== config.spaceType) {
    throw new HttpError(400, 'WrongSpaceType', `Waystation opens spaces of type ${config.spaceType} only.`)
  }
  return space
}

function inviteLink(uri, name) {
  const u = new URL(config.publicUrl + '/')
  u.searchParams.set('invite', uri)
  if (name) u.searchParams.set('name', name)
  return u.toString()
}

async function withHandles(dids) {
  const out = {}
  await Promise.all([...new Set(dids)].map(async (d) => { out[d] = await displayHandle(d) }))
  return out
}

const UPSTREAM_MESSAGE = 'A server Waystation depends on could not be reached or returned an error. Try again shortly.'

// Map protocol errors to messages a person can act on. Details go to the
// log, not to the browser.
function explain(err) {
  if (err instanceof HttpError) return err
  if (err instanceof XrpcError) {
    if (err.status === 403 && err.error === 'ScopeMissingError' && err.method === 'com.atproto.repo.uploadBlob') {
      return new HttpError(403, 'NeedUploadSignIn', 'Sign out and sign in again to allow attaching files.')
    }
    if (err.status === 403 && err.error === 'ScopeMissingError') {
      return new HttpError(403, 'NeedOwnerSignIn', 'Your sign-in does not allow this. Sign in again with "I want to host spaces" checked.')
    }
    if (['SpaceNotFound', 'SpaceDeleted', 'NotAMember', 'Forbidden', 'AuthRequired'].includes(err.error) || err.status === 403) {
      return new HttpError(403, 'NoAccess', 'You are not a member of this space, or it no longer exists.')
    }
    if (err.status === 429) return new HttpError(429, 'UpstreamRateLimited', 'The space host is rate limiting; try again shortly.')
    return new HttpError(502, 'UpstreamError', UPSTREAM_MESSAGE)
  }
  return new HttpError(502, 'UpstreamError', UPSTREAM_MESSAGE)
}

// ---------- routes ----------

async function route(req, res) {
  const url = new URL(req.url, config.publicUrl)
  const path = url.pathname
  const method = req.method

  if (method === 'GET' && STATIC[path]) {
    const [name, type] = STATIC[path]
    res.setHeader('Cache-Control', 'no-cache')
    return send(res, 200, staticFile(name), type)
  }

  if (method === 'GET' && path === '/client-metadata.json') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    return send(res, 200, clientMetadata())
  }

  if (method === 'GET' && path === '/healthz') return send(res, 200, { ok: true })

  // ----- sign-in -----

  if (method === 'GET' && path === '/oauth/login') {
    limiter.hit(`login:${clientIp(req)}`, 20)
    const handle = String(url.searchParams.get('handle') ?? '').trim().replace(/^@/, '')
    if (!handle || handle.length > 253) return redirect(res, '/?error=' + encodeURIComponent('Enter your handle.'))
    const wantOwner = url.searchParams.get('owner') === '1'
    const nonce = token()
    try {
      const authUrl = await oauth.authorize(handle, {
        scope: wantOwner ? scopes().owner : scopes().member,
        state: nonce,
      })
      res.setHeader('Set-Cookie', cookie('waystation_login', nonce, { maxAge: 900, path: '/oauth' }))
      return redirect(res, authUrl.toString())
    } catch (err) {
      log('authorize failed', err.message)
      return redirect(res, '/?error=' + encodeURIComponent(`Could not start sign-in for ${handle}.`))
    }
  }

  if (method === 'GET' && path === callbackPath) {
    limiter.hit(`login:${clientIp(req)}`, 20)
    const clear = cookie('waystation_login', '', { maxAge: 0, path: '/oauth' })
    try {
      const { session, state } = await oauth.callback(url.searchParams)
      const nonce = parseCookies(req).waystation_login
      if (!nonce || !state || !safeEqual(nonce, state)) {
        await oauth.revoke(session.did).catch(() => {})
        throw new UserFacingError('Sign-in was not started from this browser. Please try again.')
      }
      if (config.allowedDids.length && !config.allowedDids.includes(session.did)) {
        await oauth.revoke(session.did).catch(() => {})
        throw new UserFacingError('This account is not allowed on this Waystation server.')
      }
      const sid = token()
      const now = Date.now()
      const granted = String((await session.getTokenInfo(false).catch(() => ({}))).scope ?? '')
      const host = granted.includes('manage=create') && granted.includes('manage=update') ? 1 : 0
      qSessionDelOtherScope.run(session.did, host)
      qSessionTrim.run(session.did, session.did)
      qSessionPut.run(sha256(sid), session.did, token(), now, now + config.sessionDays * 86400000, host)
      for (const k of [...views.keys()]) if (k.startsWith(`${session.did} `)) views.delete(k)
      res.setHeader('Set-Cookie', [clear, cookie('waystation_sid', sid, { maxAge: config.sessionDays * 86400 })])
      log('sign-in', session.did)
      return redirect(res, '/')
    } catch (err) {
      log('callback failed', err.message)
      res.setHeader('Set-Cookie', clear)
      const msg = err instanceof UserFacingError ? err.message : 'Sign-in failed. Please try again.'
      return redirect(res, '/?error=' + encodeURIComponent(msg))
    }
  }

  // ----- API -----

  if (!path.startsWith('/api/')) return send(res, 404, { error: 'NotFound' })

  if (method === 'GET' && path === '/api/me') {
    const ws = getWebSession(req)
    if (!ws) return send(res, 200, { signedIn: false })
    const { session } = await requireUser(req)
    const scope = await grantedScope(session)
    return send(res, 200, {
      signedIn: true,
      did: session.did,
      handle: await displayHandle(session.did),
      host: ws.host && scope.includes('manage=create'),
      csrf: ws.csrf,
      maxMessageLength: config.maxMessageLength,
      canUpload: canUpload(scope),
      canReact: canReact(scope),
      reactions: REACTION_EMOJI,
      maxImageBytes: config.maxImageBytes,
      maxPdfBytes: config.maxPdfBytes,
    })
  }

  const { ws, session } = await requireUser(req)
  if (method !== 'GET') requireCsrf(req, ws)
  const did = session.did

  // Signs out this browser only. The account's OAuth session is shared by its
  // web sessions, so it is revoked only when no other live web session uses it.
  if (method === 'POST' && path === '/api/logout') {
    qSessionDel.run(ws.sidHash)
    if (qSessionLive.get(did, Date.now()).n === 0) {
      dropViewsForDid(did)
      await oauth.revoke(did).catch((err) => log('revoke failed', err.message))
    }
    res.setHeader('Set-Cookie', cookie('waystation_sid', '', { maxAge: 0 }))
    return send(res, 200, { ok: true })
  }

  if (method === 'GET' && path === '/api/spaces') {
    // Spaces made outside Waystation are opened by invite link. listSpaces would
    // need an extra read scope over every space type.
    const owned = q.spacesOwned.all(did).map((r) => ({ uri: r.uri, name: r.name }))
    const member = q.spacesMember.all(did).filter((r) => r.owner_did !== did)
    const opened = q.openedList.all(did)
    const owners = await withHandles(member.map((m) => m.owner_did))
    const seen = new Set([...owned.map((s) => s.uri), ...member.map((m) => m.uri)])
    return send(res, 200, {
      owned: owned.map((s) => ({ ...s, invite: inviteLink(s.uri, s.name) })),
      member: member.map((m) => ({ uri: m.uri, name: m.name, owner: owners[m.owner_did] })),
      opened: opened.filter((o) => !seen.has(o.uri)),
    })
  }

  if (method === 'POST' && path === '/api/spaces') {
    await requireOwnerScope(session, ws)
    limiter.hit(`manage:${did}`, config.manageActionsPerMinute)
    const body = await readJson(req)
    const name = cleanName(body.name)
    if (!name) throw new HttpError(400, 'NameRequired', 'Give the space a name.')
    if (q.spacesOwnedCount.get(did).n >= config.maxSpacesPerOwner) {
      throw new HttpError(429, 'TooManySpaces', `You can host up to ${config.maxSpacesPerOwner} spaces in Waystation.`)
    }
    const uri = await createSpace(session)
    q.spacePut.run(uri, did, name, Date.now())
    log('space created', did, uri)
    return send(res, 200, { uri, name, invite: inviteLink(uri, name) })
  }

  if (method === 'POST' && path === '/api/spaces/open') {
    const body = await readJson(req)
    const space = spaceFromInput(body.invite)
    const view = viewFor(session, space)
    view.cred = null // a fresh credential proves current membership
    try {
      await view.credential()
    } catch (err) {
      q.openedDel.run(did, space.uri)
      throw err
    }
    const name = spaceName(space.uri) ?? (cleanName(body.name) || `Space ${space.skey}`)
    q.openedPut.run(did, space.uri, name, Date.now())
    q.openedTrim.run(did, did)
    return send(res, 200, { uri: space.uri, name })
  }

  if (method === 'POST' && path === '/api/spaces/forget') {
    const body = await readJson(req)
    q.openedDel.run(did, String(body.uri ?? ''))
    return send(res, 200, { ok: true })
  }

  if (method === 'GET' && path === '/api/space') {
    const space = spaceFromInput(url.searchParams.get('uri'))
    const view = viewFor(session, space)
    try {
      await view.sync()
    } catch (err) {
      if (explain(err).code === 'NoAccess') {
        q.openedDel.run(did, space.uri)
        views.delete(`${did} ${space.uri}`)
        if (err.error === 'SpaceDeleted' || err.error === 'SpaceNotFound') forgetSpace(space.uri)
      }
      throw err
    }
    const since = Number(url.searchParams.get('v') ?? -1)
    const dir = q.spaceGet.get(space.uri)
    const base = {
      uri: space.uri,
      name: dir?.name ?? null,
      isOwner: space.authority === did,
      version: view.version,
      warning: view.error ? 'Some messages could not be read; retrying.'
        : view.tooManyWriters ? 'This space has more writers than Waystation shows; some are not displayed.' : null,
    }
    if (since === view.version) return send(res, 200, { ...base, unchanged: true })
    const messages = view.list()
    const reactions = view.reactionSummary()
    const reactors = [...reactions.values()].flatMap((list) => list.flatMap((r) => r.authors.slice(0, MAX_REACTOR_NAMES)))
    // Active members: every current writer, meaning anyone who has posted
    // or reacted. listWriters drops removed members; added members who
    // never wrote do not appear.
    const writers = [...view.writers]
    const handles = await withHandles([...messages.map((m) => m.author), ...reactors, ...writers])
    return send(res, 200, {
      ...base,
      active: writers.map((w) => ({ handle: handles[w], me: w === did }))
        .sort((a, b) => a.handle.localeCompare(b.handle)),
      messages: messages.map((m) => ({
        uri: m.uri,
        author: handles[m.author],
        mine: m.author === did,
        text: m.text,
        createdAt: m.createdAt,
        reactions: (reactions.get(m.uri) ?? []).map((r) => ({
          emoji: r.emoji,
          count: r.authors.length,
          mine: r.authors.includes(did),
          by: r.authors.slice(0, MAX_REACTOR_NAMES).map((a) => handles[a]),
        })),
        file: m.attachment ? {
          url: fileUrl(space.uri, m.author, m.attachment.cid),
          thumbUrl: m.attachment.thumb ? fileUrl(space.uri, m.author, m.attachment.thumb.cid) : null,
          kind: isImage(m.attachment.mime) ? 'image' : 'pdf',
          mime: m.attachment.mime,
          size: m.attachment.size,
          name: m.attachment.name,
          width: m.attachment.width ?? null,
          height: m.attachment.height ?? null,
        } : null,
      })),
    })
  }

  if (method === 'GET' && path === '/api/space/file') {
    const space = spaceFromInput(url.searchParams.get('uri'))
    const repo = String(url.searchParams.get('repo') ?? '')
    const cid = String(url.searchParams.get('cid') ?? '')
    if (!isDid(repo)) throw new HttpError(400, 'BadRepo')
    const view = viewFor(session, space)
    try {
      await view.sync()
    } catch (err) {
      if (explain(err).code === 'NoAccess') views.delete(`${did} ${space.uri}`)
      throw err
    }
    const att = view.findFile(repo, cid)
    if (!att) throw new HttpError(404, 'FileNotFound', 'That file is not in this space.')
    // A credential outlives removal, so prove membership with one issued in
    // the last few seconds (the page fetches each file once per load).
    if (!view.cred || Date.now() - view.cred.issuedAt > FILE_CRED_MAX_AGE_MS) {
      view.cred = null
      try {
        await view.credential()
      } catch (err) {
        if (explain(err).code === 'NoAccess') views.delete(`${did} ${space.uri}`)
        throw err
      }
    }
    // The slot is held until the response has been sent or the client has
    // gone, so slow readers cannot pile up buffered files.
    return withSlot('download', MAX_DOWNLOADS_IN_FLIGHT, async () => {
      // Listen before fetching, so a client that leaves early still frees the slot.
      const closed = new Promise((resolve) => {
        if (res.destroyed || res.writableFinished) resolve()
        else res.once('close', resolve)
      })
      const bytes = await view.fetchBlob(repo, cid, att.thumb ? config.maxThumbBytes : maxBytesFor(att.mime))
      // Serve only what the bytes really are, and only if that matches the record.
      if (sniffMime(bytes) !== att.mime) {
        log('file type mismatch', space.uri, repo, cid)
        throw new HttpError(502, 'BadFile', 'That file is not the type it claims to be.')
      }
      res.statusCode = 200
      res.setHeader('Content-Type', att.mime)
      res.setHeader('Content-Length', bytes.length)
      res.setHeader('Content-Disposition', contentDisposition(isImage(att.mime) ? 'inline' : 'attachment', att.name))
      // No browser caching: the cache is not tied to the Waystation sign-in, so
      // another account on the same browser could reuse it.
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
      res.end(bytes)
      await closed
    })
  }

  if (method === 'POST' && path === '/api/space/upload') {
    limiter.hit(`post:${did}`, config.postsPerMinute)
    limiter.hit(`upload:${did}`, config.uploadsPerMinute)
    if (!canUpload(await grantedScope(session))) {
      throw new HttpError(403, 'NeedUploadSignIn', 'Sign out and sign in again to allow attaching files.')
    }
    return withSlot('upload', MAX_UPLOADS_IN_FLIGHT, async () => {
      const form = await readForm(req)
      const space = spaceFromInput(form.get('uri'))
      const text = String(form.get('text') ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim()
      if ([...text].length > config.maxMessageLength) {
        throw new HttpError(400, 'TooLong', `Messages are limited to ${config.maxMessageLength} characters.`)
      }
      const file = form.get('file')
      if (!file || typeof file === 'string') throw new HttpError(400, 'NoFile', 'Choose a file to attach.')
      const bytes = Buffer.from(await file.arrayBuffer())
      const mime = sniffMime(bytes)
      if (!mime) throw new HttpError(415, 'BadFileType', 'Only PNG, JPEG, GIF, WebP and PDF files can be attached.')
      if (bytes.length > maxBytesFor(mime)) throw new HttpError(413, 'FileTooLarge', tooLargeMessage())
      const name = cleanFileName(file.name, mime)
      const extra = isImage(mime) ? await thumbFromForm(form) : null
      // Same membership check as text messages.
      const v = viewFor(session, space)
      v.cred = null
      await v.credential()
      const blob = await uploadBlob(session, bytes, mime)
      const attachment = { blob, name }
      if (extra?.thumb) attachment.thumb = await uploadBlob(session, extra.thumb.bytes, extra.thumb.mime)
      if (extra?.width) Object.assign(attachment, { width: extra.width, height: extra.height })
      const out = await postMessage(session, space, text, attachment)
      v.lastSync = 0
      log('file posted', did, space.uri, mime, bytes.length, attachment.thumb ? `thumb ${extra.thumb.bytes.length}` : 'no thumb')
      return send(res, 200, { uri: out.uri })
    })
  }

  if (method === 'POST' && path === '/api/space/react') {
    limiter.hit(`react:${did}`, config.reactionsPerMinute)
    if (!canReact(await grantedScope(session))) {
      throw new HttpError(403, 'NeedReactSignIn', 'Sign out and sign in again to allow reactions.')
    }
    const body = await readJson(req)
    const space = spaceFromInput(body.uri)
    const emoji = paletteEmoji(body.emoji)
    if (!emoji) throw new HttpError(400, 'BadEmoji', 'That reaction is not available.')
    const subject = String(body.message ?? '')
    const on = body.on === true
    const v = viewFor(session, space)
    await v.sync()
    if (![...v.messages.values()].some((m) => m.uri === subject)) {
      throw new HttpError(404, 'MessageNotFound', 'That message is not in this space.')
    }
    // Same membership check as posting: a cached credential outlives removal.
    v.cred = null
    await v.credential()
    const own = v.ownReactions(did, subject, emoji)
    if (on && !own.length) {
      const { rkey, value } = await addReaction(session, space, subject, emoji)
      if (rkey) v.applyReaction(did, rkey, value)
    } else if (!on) {
      for (const rkey of own) {
        await deleteReaction(session, space, rkey)
        v.applyReaction(did, rkey, null)
      }
    }
    v.version++
    v.lastSync = 0
    return send(res, 200, { ok: true })
  }

  if (method === 'POST' && path === '/api/space/message') {
    limiter.hit(`post:${did}`, config.postsPerMinute)
    const body = await readJson(req)
    const space = spaceFromInput(body.uri)
    const text = String(body.text ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim()
    if (!text) throw new HttpError(400, 'EmptyMessage')
    if ([...text].length > config.maxMessageLength) {
      throw new HttpError(400, 'TooLong', `Messages are limited to ${config.maxMessageLength} characters.`)
    }
    // Writes into one's own repo are not gated by membership, so check it
    // with a fresh credential (a cached one outlives removal).
    const v = viewFor(session, space)
    v.cred = null
    await v.credential()
    const out = await postMessage(session, space, text)
    const view = views.get(`${did} ${space.uri}`)
    if (view) view.lastSync = 0 // next poll syncs at once
    return send(res, 200, { uri: out.uri })
  }

  if (path === '/api/space/members') {
    const space = spaceFromInput(method === 'GET' ? url.searchParams.get('uri') : (req.body = await readJson(req)).uri)
    if (space.authority !== did) throw new HttpError(403, 'NotOwner', 'Only the space owner manages members.')
    await requireOwnerScope(session, ws)

    if (method === 'GET') {
      const members = (await listMembers(session, space)).filter((m) => m.did !== did)
      const handles = await withHandles(members.map((m) => m.did))
      return send(res, 200, { members: members.map((m) => ({ did: m.did, handle: handles[m.did] })) })
    }

    limiter.hit(`manage:${did}`, config.manageActionsPerMinute)
    const body = req.body
    if (method === 'POST' && body.action === 'add') {
      let memberDid
      try {
        memberDid = isDid(body.handle) ? body.handle : await resolveHandle(body.handle)
      } catch {
        throw new HttpError(400, 'UnknownHandle', `Could not find ${String(body.handle).slice(0, 100)}.`)
      }
      if (memberDid === did) throw new HttpError(400, 'Self', 'You already own this space.')
      if ((await listMembers(session, space)).length >= MAX_MEMBERS) {
        throw new HttpError(429, 'TooManyMembers', `Waystation spaces are limited to ${MAX_MEMBERS} members.`)
      }
      await addMember(session, space, memberDid)
      if (q.spaceGet.get(space.uri)) q.memberPut.run(space.uri, memberDid, await displayHandle(memberDid), Date.now())
      log('member added', space.uri, memberDid)
      return send(res, 200, { did: memberDid, handle: await displayHandle(memberDid) })
    }
    if (method === 'POST' && body.action === 'remove') {
      if (!isDid(body.did)) throw new HttpError(400, 'BadDid')
      await removeMember(session, space, body.did)
      q.memberDel.run(space.uri, body.did)
      log('member removed', space.uri, body.did)
      return send(res, 200, { ok: true })
    }
  }

  return send(res, 404, { error: 'NotFound' })
}

// ---------- server ----------

const server = createServer(async (req, res) => {
  securityHeaders(res)
  try {
    await route(req, res)
  } catch (err) {
    if (!(err instanceof HttpError) && !(err instanceof RateLimitError)) {
      log('upstream', req.method, req.url.split('?')[0], err.message)
    }
    const e = err instanceof RateLimitError ? new HttpError(429, err.code, err.message)
      : err instanceof HttpError || err instanceof XrpcError ? explain(err) : err
    if (e instanceof HttpError) {
      if (e.status >= 500) log('error', req.method, req.url.split('?')[0], e.message)
      if (!res.headersSent) send(res, e.status, { error: e.code, message: e.message })
      return
    }
    log('unhandled', req.method, req.url.split('?')[0], err.stack ?? err.message)
    const x = explain(err)
    if (!res.headersSent) send(res, x.status, { error: x.code, message: x.message })
  }
})
// Long enough for a 12 MB upload on a slow connection.
server.requestTimeout = 180000
server.headersTimeout = 15000

setInterval(() => {
  purgeExpired(db)
  evictViews()
  limiter.sweep()
  sweepCaches()
}, 60000).unref()

server.listen(config.port, config.host, () => {
  log(`Waystation listening on http://${config.host}:${config.port} (public ${config.publicUrl}, space type ${config.spaceType})`)
})

function shutdown() {
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

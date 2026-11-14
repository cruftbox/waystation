// Handle and DID resolution with small in-memory caches.

import { resolveTxt } from 'node:dns/promises'
import { safeFetch, checkUrl } from './net.js'
import { config } from './config.js'

const TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const MAX_BODY = 256 * 1024

const handleCache = new Map() // handle -> { did, t }
const didCache = new Map() // did -> { doc, t }
const verifiedHandleCache = new Map() // did -> { handle, t }
const MAX_CACHE = 5000

function remember(cache, key, value) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value)
  cache.set(key, value)
}

export function sweepCaches() {
  const now = Date.now()
  for (const c of [handleCache, didCache, verifiedHandleCache]) {
    for (const [k, v] of c) if (now - v.t >= TTL_MS) c.delete(k)
  }
}

const HANDLE_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
// atproto supports did:web for hostnames only, not path-based did:web;
// a port is allowed only for localhost (development).
const DID_RE = /^did:(plc:[a-z2-7]{24}|web:([a-zA-Z0-9.-]+|localhost%3[aA]\d{1,5}))$/

export function normalizeHandle(input) {
  const h = String(input ?? '').trim().replace(/^@/, '').toLowerCase()
  if (h.length > 253 || !HANDLE_RE.test(h)) return null
  return h
}

export function isDid(s) {
  return typeof s === 'string' && DID_RE.test(s)
}

// Outbound requests go through net.safeFetch, which refuses private
// addresses at connect time and caps response size.
export { isPrivateAddress } from './net.js'

async function fetchLimited(url, accept = 'application/json') {
  const res = await safeFetch(url, { headers: { accept }, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_BODY })
  if (!res.ok) throw new Error(`${new URL(url).host} -> HTTP ${res.status}`)
  return res.text
}

export async function resolveHandle(input) {
  const handle = normalizeHandle(input)
  if (!handle) throw new Error('not a valid handle')
  const hit = handleCache.get(handle)
  if (hit && Date.now() - hit.t < TTL_MS) return hit.did

  let did = null
  try {
    const records = await resolveTxt(`_atproto.${handle}`)
    for (const r of records) {
      const s = r.join('')
      if (s.startsWith('did=') && isDid(s.slice(4))) {
        did = s.slice(4)
        break
      }
    }
  } catch { /* fall through to HTTPS */ }
  if (!did) {
    try {
      const s = (await fetchLimited(`https://${handle}/.well-known/atproto-did`, 'text/plain')).trim()
      if (isDid(s)) did = s
    } catch { /* unresolved */ }
  }
  if (!did) throw new Error(`could not resolve handle ${handle}`)
  remember(handleCache, handle, { did, t: Date.now() })
  return did
}

export async function resolveDid(did) {
  if (!isDid(did)) throw new Error('not a valid DID')
  const hit = didCache.get(did)
  if (hit && Date.now() - hit.t < TTL_MS) return hit.doc

  let url
  if (did.startsWith('did:plc:')) {
    url = `${config.plcUrl}/${did}`
  } else {
    const host = decodeURIComponent(did.slice('did:web:'.length))
    url = `https://${host}/.well-known/did.json`
  }
  const raw = JSON.parse(await fetchLimited(url))
  if (raw.id !== did) throw new Error(`DID document id mismatch for ${did}`)
  const svc = (raw.service ?? []).find((s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`)
  const kem = (raw.verificationMethod ?? []).find((m) => m.id.endsWith('#atproto_kem'))
  const aka = (raw.alsoKnownAs ?? []).find((a) => a.startsWith('at://'))
  const doc = {
    did,
    pds: svc?.serviceEndpoint ? String(svc.serviceEndpoint).replace(/\/$/, '') : null,
    kemKey: kem ? `did:key:${kem.publicKeyMultibase}` : null,
    claimedHandle: aka ? aka.slice('at://'.length) : null,
  }
  remember(didCache, did, { doc, t: Date.now() })
  return doc
}

// Forget a DID document, e.g. after a MAC failure that may mean a rotated key.
export function forgetDid(did) {
  didCache.delete(did)
}

// The handle to show for a DID: the DID document's handle if it resolves
// back to the same DID, otherwise the DID itself.
export async function displayHandle(did) {
  const hit = verifiedHandleCache.get(did)
  if (hit && Date.now() - hit.t < TTL_MS) return hit.handle
  let handle = did
  try {
    const doc = await resolveDid(did)
    if (doc.claimedHandle && (await resolveHandle(doc.claimedHandle)) === did) handle = doc.claimedHandle
  } catch { /* keep DID */ }
  remember(verifiedHandleCache, did, { handle, t: Date.now() })
  return handle
}

export async function pdsFor(did) {
  const doc = await resolveDid(did)
  if (!doc.pds) throw new Error(`${did} has no PDS endpoint`)
  checkUrl(doc.pds)
  return doc.pds
}

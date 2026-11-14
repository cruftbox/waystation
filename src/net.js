// Outbound HTTPS for user-controlled hosts (PDS endpoints from DID
// documents, handle domains). Every connection's address is checked at
// connect time, so a name that passes a check and then re-resolves to a
// private address (DNS rebinding) is still refused. Response bodies are
// capped while streaming.

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import { config } from './config.js'

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

// Expand an IPv6 address to 8 lowercase hex groups (handles "::" and a
// trailing dotted IPv4 part). Returns null if it is not IPv6.
function expandIPv6(ip) {
  if (isIP(ip) !== 6) return null
  let s = ip.toLowerCase().replace(/%.*$/, '')
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number)
    s = s.slice(0, -dotted[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill('0')
  return [...h, ...fill, ...t].map((g) => g.padStart(4, '0'))
}

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const g = expandIPv6(ip)
  if (!g) return true // not an IP at all: refuse
  const embeddedV4 = () => {
    const x = parseInt(g[6], 16)
    const y = parseInt(g[7], 16)
    return `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`
  }
  const first = parseInt(g[0], 16)
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped)
  if (g.slice(0, 5).every((x) => x === '0000') && (g[5] === '0000' || g[5] === 'ffff')) {
    if (g[5] === '0000' && g[6] === '0000') return true // :: and ::1 and ::/112
    return isPrivateAddress(embeddedV4())
  }
  // 64:ff9b::/96 NAT64 maps IPv4 too
  if (g[0] === '0064' && g[1] === 'ff9b') return isPrivateAddress(embeddedV4())
  return (first & 0xfe00) === 0xfc00 // fc00::/7 unique local
    || (first & 0xffc0) === 0xfe80 // fe80::/10 link local
    || (first & 0xff00) === 0xff00 // multicast
    || (first === 0x2001 && parseInt(g[1], 16) === 0x0db8) // documentation
}

// dns.lookup replacement that refuses private addresses.
function safeLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err)
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }]
    const bad = list.find((a) => isPrivateAddress(a.address))
    if (!list.length || bad) {
      return callback(Object.assign(new Error(`refusing private address for ${hostname}`), { code: 'EPRIVATE' }))
    }
    if (options.all) return callback(null, list)
    return callback(null, list[0].address, list[0].family)
  })
}

export class FetchError extends Error {}

export function checkUrl(urlString) {
  const url = new URL(urlString)
  if (config.allowInsecureHosts) return url
  if (url.protocol !== 'https:') throw new FetchError(`refusing non-HTTPS host ${url.origin}`)
  if (url.username || url.password) throw new FetchError('refusing URL with credentials')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isPrivateAddress(host)) throw new FetchError(`refusing private address ${host}`)
  return url
}

// Minimal fetch: GET or POST, no redirects, timeout, size cap.
// Returns { ok, status, headers: Headers, text, buffer }. With binary: true
// the body is not decoded and text is set only for error responses.
export function safeFetch(urlString, { method = 'GET', headers = {}, body, timeoutMs = 15000, maxBytes = MAX_RESPONSE_BYTES, binary = false } = {}) {
  const url = checkUrl(urlString)
  const insecure = config.allowInsecureHosts && url.protocol === 'http:'
  const doRequest = insecure ? httpRequest : httpsRequest
  return new Promise((resolve, reject) => {
    const req = doRequest(url, {
      method,
      headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers,
      lookup: config.allowInsecureHosts ? undefined : safeLookup,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > maxBytes) {
          req.destroy(new FetchError(`response from ${url.host} exceeds ${maxBytes} bytes`))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        const h = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const x of v) h.append(k, x)
          else if (v !== undefined) h.set(k, String(v))
        }
        const status = res.statusCode ?? 0
        const ok = status >= 200 && status < 300
        const buffer = Buffer.concat(chunks)
        const text = binary && ok ? '' : buffer.toString('utf8')
        resolve({ ok, status, headers: h, text, buffer })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new FetchError(`timeout contacting ${url.host}`)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

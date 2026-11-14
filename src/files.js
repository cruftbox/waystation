// Attachments: allowed file types, content sniffing, size caps, and
// validation of attachment fields read from records. The type of a file is
// decided by its first bytes, never by the name or type a client declares.

import { config } from './config.js'

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const FILE_TYPES = [...IMAGE_TYPES, 'application/pdf']

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
}

export function isImage(mime) {
  return IMAGE_TYPES.includes(mime)
}

export function maxBytesFor(mime) {
  if (mime === 'application/pdf') return config.maxPdfBytes
  if (isImage(mime)) return config.maxImageBytes
  return 0
}

// The largest file Parlor accepts of any type.
export function maxFileBytes() {
  return Math.max(config.maxPdfBytes, config.maxImageBytes)
}

const startsWith = (buf, bytes, at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b)
const ascii = (s) => [...s].map((c) => c.charCodeAt(0))

// The file's type from its leading bytes, or null if it is not one of the
// allowed types.
export function sniffMime(buf) {
  if (!buf || buf.length < 8) return null
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(buf, ascii('%PDF-'))) return 'application/pdf'
  return null
}

// A display and download name: no control characters, path separators or
// quotes; at most 200 code points; falls back to file.<ext>.
export function cleanFileName(name, mime) {
  let s = typeof name === 'string' ? name : ''
  s = s.replace(/[\u0000-\u001F\u007F"\\/<>:|?*]/g, '').replace(/\s+/g, ' ').trim()
  s = s.replace(/^\.+/, '')
  const cps = [...s]
  if (cps.length > 200) s = cps.slice(0, 200).join('')
  return s || `file.${EXT[mime] ?? 'bin'}`
}

const CID_RE = /^b[a-z2-7]{20,120}$/

// Thumbnails: a small copy of an image made by the poster's browser.
export const THUMB_TYPES = ['image/webp', 'image/jpeg', 'image/png']
export const MAX_DIMENSION = 100000

// A blob ref's { cid, mime, size } if it is well formed, of an allowed type
// and within maxBytes(mime); otherwise null.
function blobFromRecord(f, types, maxBytes) {
  if (!f || typeof f !== 'object' || f.$type !== 'blob') return null
  const cid = f.ref?.$link
  const mime = String(f.mimeType ?? '').toLowerCase()
  const size = f.size
  if (typeof cid !== 'string' || !CID_RE.test(cid)) return null
  if (!types.includes(mime)) return null
  if (!Number.isInteger(size) || size <= 0 || size > maxBytes(mime)) return null
  return { cid, mime, size }
}

const isDimension = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION

// Validate an attachment field from a record. Returns
// { cid, mime, size, name } plus, for an image, thumb: { cid, mime, size }
// and width and height when present and valid; or null. A bad thumbnail or
// size is dropped and the full image is used.
export function attachmentFromRecord(a) {
  if (!a || typeof a !== 'object') return null
  const file = blobFromRecord(a.file, FILE_TYPES, maxBytesFor)
  if (!file) return null
  const out = { ...file, name: cleanFileName(a.name, file.mime) }
  if (!isImage(file.mime)) return out
  const thumb = blobFromRecord(a.thumb, THUMB_TYPES, () => config.maxThumbBytes)
  if (thumb && thumb.cid !== file.cid) out.thumb = thumb
  if (isDimension(a.width) && isDimension(a.height)) {
    out.width = a.width
    out.height = a.height
  }
  return out
}

// Content-Disposition value for a download.
export function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/[%;]/g, '_')
  const ext = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${ext}`
}

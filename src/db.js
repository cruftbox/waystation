// SQLite storage (node:sqlite): OAuth state and sessions, web sessions, and
// the directory of spaces Waystation manages. Message contents are never stored.

import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

export function openDb(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(path)
  if (path !== ':memory:') {
    try { chmodSync(path, 0o600) } catch { /* Windows: no POSIX modes */ }
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS kv (
      ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, expires INTEGER,
      PRIMARY KEY (ns, k)
    );
    CREATE TABLE IF NOT EXISTS web_session (
      sid_hash TEXT PRIMARY KEY, did TEXT NOT NULL, csrf TEXT NOT NULL,
      created INTEGER NOT NULL, expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS web_session_did ON web_session(did);
    CREATE TABLE IF NOT EXISTS space (
      uri TEXT PRIMARY KEY, owner_did TEXT NOT NULL, name TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS space_owner ON space(owner_did);
    CREATE TABLE IF NOT EXISTS space_member (
      uri TEXT NOT NULL, did TEXT NOT NULL, handle TEXT, added INTEGER NOT NULL,
      PRIMARY KEY (uri, did)
    );
    CREATE INDEX IF NOT EXISTS space_member_did ON space_member(did);
    CREATE TABLE IF NOT EXISTS opened_space (
      did TEXT NOT NULL, uri TEXT NOT NULL, name TEXT NOT NULL, opened INTEGER NOT NULL,
      PRIMARY KEY (did, uri)
    );
  `)
  // host: the sign-in that created this web session granted manage scope.
  const cols = db.prepare('PRAGMA table_info(web_session)').all().map((c) => c.name)
  if (!cols.includes('host')) db.exec('ALTER TABLE web_session ADD COLUMN host INTEGER NOT NULL DEFAULT 0')
  return db
}

// AES-256-GCM for values at rest (OAuth sessions hold refresh tokens and
// DPoP private keys). The key comes from SESSION_KEY, kept outside the DB, so
// a copied database file alone does not expose sessions.
export function makeCipher(hexKey) {
  const key = Buffer.from(hexKey, 'hex')
  if (key.length !== 32) throw new Error('SESSION_KEY must be 64 hex characters (32 bytes)')
  return {
    seal(text) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.')
    },
    open(sealed) {
      const [v, iv, tag, body] = sealed.split('.')
      if (v !== 'v1') throw new Error('unknown sealed format')
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
      d.setAuthTag(Buffer.from(tag, 'base64'))
      return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8')
    },
  }
}

// A namespaced key-value store with optional expiry and optional
// encryption, used for the OAuth client's state and session stores.
export function kvStore(db, ns, ttlMs, cipher) {
  const enc = (s) => (cipher ? cipher.seal(s) : s)
  const dec = (s) => (cipher ? cipher.open(s) : s)
  const get = db.prepare('SELECT v, expires FROM kv WHERE ns = ? AND k = ?')
  const set = db.prepare('INSERT OR REPLACE INTO kv (ns, k, v, expires) VALUES (?, ?, ?, ?)')
  const del = db.prepare('DELETE FROM kv WHERE ns = ? AND k = ?')
  return {
    async get(k) {
      const row = get.get(ns, k)
      if (!row) return undefined
      if (row.expires && row.expires < Date.now()) {
        del.run(ns, k)
        return undefined
      }
      return JSON.parse(dec(row.v))
    },
    async set(k, v) {
      set.run(ns, k, enc(JSON.stringify(v)), ttlMs ? Date.now() + ttlMs : null)
    },
    async del(k) {
      del.run(ns, k)
    },
  }
}

export function purgeExpired(db) {
  const now = Date.now()
  db.prepare('DELETE FROM kv WHERE expires IS NOT NULL AND expires < ?').run(now)
  db.prepare('DELETE FROM web_session WHERE expires < ?').run(now)
  // OAuth sessions (refresh tokens, DPoP keys) are kept only while the user
  // has a live web session; the OAuth session store is keyed by DID.
  db.prepare(`DELETE FROM kv WHERE ns = 'oauth_session'
              AND k NOT IN (SELECT did FROM web_session)`).run()
}

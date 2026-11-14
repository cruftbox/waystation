import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.SPACE_TYPE = 'com.example.parlor.space'
process.env.MESSAGE_COLLECTION = 'com.example.parlor.message'
process.env.MAX_MESSAGE_LENGTH = '10'
process.env.MAX_MESSAGES_PER_VIEW = '3'
process.env.PARLOR_ENV_FILE = '/nonexistent'

const { parseSpaceUri, messageFromRecord, compareMessages, SpaceView } = await import('../../src/spaces.js')
const { openDb, kvStore, makeCipher } = await import('../../src/db.js')
const { isPrivateAddress, normalizeHandle, isDid } = await import('../../src/identity.js')
const { checkUrl, safeFetch } = await import('../../src/net.js')
const { RateLimiter, RateLimitError } = await import('../../src/ratelimit.js')

const OWNER = 'did:plc:4nowfcob4en66jiemgz77efr'
const OTHER = 'did:plc:3eo7g3hklz26k7kkketzqth7'
const SPACE = `at://${OWNER}/space/com.example.parlor.space/3n2bgzhi4hp2a`

test('parseSpaceUri accepts space URIs and rejects others', () => {
  assert.deepEqual(parseSpaceUri(SPACE), {
    uri: SPACE, authority: OWNER, spaceType: 'com.example.parlor.space', skey: '3n2bgzhi4hp2a',
  })
  assert.equal(parseSpaceUri(`at://${OWNER}/app.bsky.feed.post/abc`), null)
  assert.equal(parseSpaceUri('https://example.com'), null)
  assert.equal(parseSpaceUri(`${SPACE}/extra`), null)
})

test('messageFromRecord cleans, caps and rejects', () => {
  assert.deepEqual(messageFromRecord({ text: ' hi\u0007 ', createdAt: '2026-11-14T10:00:00Z' }),
    { text: 'hi', createdAt: '2026-11-14T10:00:00.000Z' })
  assert.equal(messageFromRecord({ text: '0123456789abc' }).text, '0123456789…')
  assert.equal(messageFromRecord({ text: '' }), null)
  assert.equal(messageFromRecord({ text: 5 }), null)
  assert.equal(messageFromRecord(null), null)
  assert.equal(messageFromRecord({ text: 'x', createdAt: 'nope' }).createdAt, null)
})

test('compareMessages orders by createdAt, author, rkey', () => {
  const a = { createdAt: '2026-01-01T00:00:00.000Z', author: OTHER, rkey: 'b' }
  const b = { createdAt: '2026-01-01T00:00:00.000Z', author: OTHER, rkey: 'c' }
  const c = { createdAt: '2025-12-31T00:00:00.000Z', author: OWNER, rkey: 'z' }
  assert.deepEqual([b, a, c].sort(compareMessages), [c, a, b])
})

function view() {
  return new SpaceView({ session: { did: OWNER }, space: parseSpaceUri(SPACE) })
}
const op = (rkey, rev, value, extra = {}) => ({
  collection: 'com.example.parlor.message', rkey, rev, cid: 'bafy', prev: null, value, ...extra,
})

test('applyOps adds, updates, deletes and ignores other collections', () => {
  const v = view()
  v.writers.add(OTHER)
  v.applyOps(OTHER, [
    op('1', 'r1', { text: 'one', createdAt: '2026-01-01T00:00:01Z' }),
    op('2', 'r2', { text: 'two', createdAt: '2026-01-01T00:00:02Z' }),
    { collection: 'com.other.thing', rkey: 'x', rev: 'r3', cid: 'bafy', value: { text: 'nope' } },
  ])
  assert.deepEqual(v.list().map((m) => m.text), ['one', 'two'])
  assert.equal(v.since.get(OTHER), 'r3')
  assert.equal(v.list()[0].uri, `at://${OTHER}/com.example.parlor.message/1`)
  const before = v.version
  v.applyOps(OTHER, [{ collection: 'com.example.parlor.message', rkey: '1', rev: 'r4', cid: null }])
  assert.deepEqual(v.list().map((m) => m.text), ['two'])
  assert.ok(v.version > before)
})

test('future createdAt is clamped to the time seen', () => {
  const v = view()
  v.applyOps(OTHER, [op('1', 'r1', { text: 'future', createdAt: '2099-01-01T00:00:00Z' })])
  assert.ok(Date.parse(v.list()[0].createdAt) <= Date.now())
})

test('trimming is by arrival, so back-dated records cannot evict newer ones', () => {
  const v = view()
  v.applyOps(OTHER, ['1', '2', '3'].map((k) => op(k, `r${k}`, { text: k, createdAt: `2026-01-01T00:00:0${k}Z` })))
  v.applyOps(OTHER, [op('4', 'r4', { text: 'old-dated', createdAt: '2000-01-01T00:00:00Z' })])
  assert.deepEqual(v.list().map((m) => m.text).sort(), ['2', '3', 'old-dated'])
})

test('message cap counts code points', () => {
  assert.equal(messageFromRecord({ text: '😀'.repeat(10) }).text, '😀'.repeat(10))
  assert.equal(messageFromRecord({ text: '😀'.repeat(11) }).text, '😀'.repeat(10) + '…')
})

test('did:web is hostname-only', () => {
  assert.equal(isDid('did:web:example.com'), true)
  assert.equal(isDid('did:web:localhost%3A2583'), true)
  assert.equal(isDid('did:web:example.com%3A443'), false)
  assert.equal(isDid('did:web:example.com:user'), false)
})

test('applyOps keeps only the newest messages per view', () => {
  const v = view()
  v.applyOps(OTHER, ['1', '2', '3', '4', '5'].map((k) => op(k, `r${k}`, { text: k, createdAt: `2026-01-01T00:00:0${k}Z` })))
  assert.deepEqual(v.list().map((m) => m.text), ['3', '4', '5'])
})

test('dropRepo hides a removed writer', () => {
  const v = view()
  v.writers.add(OTHER)
  v.applyOps(OTHER, [op('1', 'r1', { text: 'theirs', createdAt: '2026-01-01T00:00:01Z' })])
  v.applyOps(OWNER, [op('2', 'r2', { text: 'mine', createdAt: '2026-01-01T00:00:02Z' })])
  v.dropRepo(OTHER)
  assert.deepEqual(v.list().map((m) => m.text), ['mine'])
  assert.equal(v.since.has(OTHER), false)
})

test('cipher round-trips and detects tampering', () => {
  const c = makeCipher('11'.repeat(32))
  const sealed = c.seal('secret')
  assert.notEqual(sealed, 'secret')
  assert.equal(c.open(sealed), 'secret')
  const parts = sealed.split('.')
  parts[3] = Buffer.from('other').toString('base64')
  assert.throws(() => c.open(parts.join('.')))
  assert.throws(() => makeCipher('abcd'))
})

test('kvStore stores encrypted values and expires them', async () => {
  const db = openDb(':memory:')
  const c = makeCipher('22'.repeat(32))
  const s = kvStore(db, 'ns', null, c)
  await s.set('k', { a: 1 })
  assert.deepEqual(await s.get('k'), { a: 1 })
  const raw = db.prepare('SELECT v FROM kv WHERE k = ?').get('k').v
  assert.ok(!raw.includes('"a"'))
  await s.del('k')
  assert.equal(await s.get('k'), undefined)
  const t = kvStore(db, 'tmp', -1)
  await t.set('x', 1)
  assert.equal(await t.get('x'), undefined)
})

test('private addresses are refused', async () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:a00:1', '::7f00:1', '64:ff9b::a00:1', '::ffff:192.168.0.1', 'fe80::1', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '67.43.2.255', '2606:4700::1111', '::ffff:808:808']) assert.equal(isPrivateAddress(ip), false, ip)
  assert.throws(() => checkUrl('http://example.com'))
  assert.throws(() => checkUrl('https://127.0.0.1:5000'))
  assert.throws(() => checkUrl('https://[::1]/'))
  // A name resolving to loopback is refused at connect time.
  await assert.rejects(safeFetch('https://localhost:5000/'), /private address/)
})

test('normalizeHandle', () => {
  assert.equal(normalizeHandle('@Alice.Example.com '), 'alice.example.com')
  assert.equal(normalizeHandle('127.0.0.1'), null)
  assert.equal(normalizeHandle('nodot'), null)
})

test('RateLimiter', () => {
  const r = new RateLimiter()
  r.hit('k', 2)
  r.hit('k', 2)
  assert.throws(() => r.hit('k', 2), RateLimitError)
  r.hit('other', 2)
})

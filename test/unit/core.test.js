import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.SPACE_TYPE = 'com.example.parlor.space'
process.env.MESSAGE_COLLECTION = 'com.example.parlor.message'
process.env.REACTION_COLLECTION = 'com.example.parlor.reaction'
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
    { text: 'hi', createdAt: '2026-11-14T10:00:00.000Z', attachment: null })
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

// ---------- attachments ----------

const { sniffMime, cleanFileName, attachmentFromRecord, contentDisposition, maxBytesFor } = await import('../../src/files.js')
const { scopes, canUpload } = await import('../../src/oauth.js')

const CID = 'bafkreiaxzdx6sd37xbkctelbhk4h6uexasawpax3mv2mtq6gzxf55iokja'
const blobRef = (mimeType, size = 100) => ({ $type: 'blob', ref: { $link: CID }, mimeType, size })
const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)])

test('sniffMime recognises the five types by content only', () => {
  assert.equal(sniffMime(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(sniffMime(pad([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffMime(pad([...Buffer.from('GIF89a')])), 'image/gif')
  assert.equal(sniffMime(pad([...Buffer.from('RIFF\0\0\0\0WEBPVP8 ')])), 'image/webp')
  assert.equal(sniffMime(pad([...Buffer.from('%PDF-1.4')])), 'application/pdf')
  assert.equal(sniffMime(pad([...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')])), null)
  assert.equal(sniffMime(pad([...Buffer.from('<html><script>')])), null)
  assert.equal(sniffMime(pad([...Buffer.from('RIFF\0\0\0\0WAVEfmt ')])), null)
  assert.equal(sniffMime(Buffer.from('%PDF')), null)
})

test('cleanFileName strips unsafe characters and falls back', () => {
  assert.equal(cleanFileName('../../etc/passwd', 'application/pdf'), 'etcpasswd')
  assert.equal(cleanFileName('a"b\c<d>.pdf', 'application/pdf'), 'abcd.pdf')
  assert.equal(cleanFileName('', 'image/png'), 'file.png')
  assert.equal(cleanFileName(null, 'image/jpeg'), 'file.jpg')
  assert.equal([...cleanFileName('x'.repeat(500), 'image/png')].length, 200)
  assert.equal(cleanFileName('line\nbreak.png', 'image/png'), 'linebreak.png')
})

test('attachmentFromRecord validates blob refs', () => {
  assert.deepEqual(attachmentFromRecord({ file: blobRef('image/png'), name: 'map.png' }),
    { cid: CID, mime: 'image/png', size: 100, name: 'map.png' })
  assert.equal(attachmentFromRecord({ file: blobRef('image/svg+xml') }), null)
  assert.equal(attachmentFromRecord({ file: blobRef('text/html') }), null)
  assert.equal(attachmentFromRecord({ file: { ...blobRef('image/png'), ref: { $link: 'not a cid' } } }), null)
  assert.equal(attachmentFromRecord({ file: { ...blobRef('image/png'), $type: 'other' } }), null)
  assert.equal(attachmentFromRecord({ file: blobRef('image/png', maxBytesFor('image/png') + 1) }), null)
  assert.equal(attachmentFromRecord({ file: blobRef('application/pdf', maxBytesFor('application/pdf')) }).mime, 'application/pdf')
  assert.equal(attachmentFromRecord({ file: blobRef('image/png', 0) }), null)
  assert.equal(attachmentFromRecord(null), null)
  assert.equal(attachmentFromRecord({ file: blobRef('application/pdf') }).name, 'file.pdf')
})

test('messageFromRecord accepts a file with empty text, and drops bad files', () => {
  const m = messageFromRecord({ text: '', attachment: { file: blobRef('image/gif'), name: 'x.gif' }, createdAt: '2026-11-14T10:00:00Z' })
  assert.equal(m.text, '')
  assert.equal(m.attachment.mime, 'image/gif')
  assert.equal(messageFromRecord({ text: '', attachment: { file: blobRef('image/svg+xml') } }), null)
  assert.equal(messageFromRecord({ text: 'hi', attachment: { file: blobRef('image/svg+xml') } }).attachment, null)
})

test('applyOps keeps attachments and findFile checks author and CID', () => {
  const v = view()
  v.writers.add(OTHER)
  v.applyOps(OTHER, [op('1', 'r1', { text: '', attachment: { file: blobRef('application/pdf'), name: 'mod.pdf' }, createdAt: '2026-01-01T00:00:01Z' })])
  assert.equal(v.findFile(OTHER, CID).name, 'mod.pdf')
  assert.equal(v.findFile(OWNER, CID), null)
  assert.equal(v.findFile(OTHER, 'bafkreiother'), null)
  v.dropRepo(OTHER)
  assert.equal(v.findFile(OTHER, CID), null)
})

const CID2 = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq'
const thumbRef = (mimeType = 'image/webp', size = 5000) => ({ $type: 'blob', ref: { $link: CID2 }, mimeType, size })

test('attachmentFromRecord keeps a valid thumbnail and size for images only', () => {
  const a = attachmentFromRecord({ file: blobRef('image/jpeg', 4_000_000), name: 'p.jpg', thumb: thumbRef(), width: 4032, height: 3024 })
  assert.deepEqual(a.thumb, { cid: CID2, mime: 'image/webp', size: 5000 })
  assert.equal(a.width, 4032)
  assert.equal(a.height, 3024)
  // Too large, wrong type, same CID as the file, or on a PDF: dropped.
  assert.equal(attachmentFromRecord({ file: blobRef('image/png'), thumb: thumbRef('image/webp', 256 * 1024 + 1) }).thumb, undefined)
  assert.equal(attachmentFromRecord({ file: blobRef('image/png'), thumb: thumbRef('image/gif') }).thumb, undefined)
  assert.equal(attachmentFromRecord({ file: blobRef('image/png'), thumb: blobRef('image/webp') }).thumb, undefined)
  assert.equal(attachmentFromRecord({ file: blobRef('application/pdf'), thumb: thumbRef(), width: 1, height: 1 }).thumb, undefined)
  // Bad sizes are dropped; the attachment stays.
  const b = attachmentFromRecord({ file: blobRef('image/png'), width: 0, height: 10 })
  assert.equal(b.width, undefined)
  assert.equal(attachmentFromRecord({ file: blobRef('image/png'), width: 1.5, height: 10 }).width, undefined)
})

test('findFile serves a thumbnail with its own type', () => {
  const v = view()
  v.writers.add(OTHER)
  v.applyOps(OTHER, [op('1', 'r1', { text: '', attachment: { file: blobRef('image/png'), name: 'map.png', thumb: thumbRef() }, createdAt: '2026-01-01T00:00:01Z' })])
  assert.deepEqual(v.findFile(OTHER, CID), { mime: 'image/png', size: 100, name: 'map.png', thumb: false })
  assert.deepEqual(v.findFile(OTHER, CID2), { mime: 'image/webp', size: 5000, name: 'map.png', thumb: true })
})

test('contentDisposition quotes safely', () => {
  assert.equal(contentDisposition('attachment', 'Tomb of Annihilation.pdf'),
    `attachment; filename="Tomb of Annihilation.pdf"; filename*=UTF-8''Tomb%20of%20Annihilation.pdf`)
  assert.match(contentDisposition('inline', 'café;%.png'), /^inline; filename="caf___.png"; filename\*=UTF-8''caf%C3%A9%3B%25\.png$/)
})

test('scopes request upload permission and canUpload reads it', () => {
  const { member, owner } = scopes()
  const blob = 'blob?accept=application/pdf&accept=image/gif&accept=image/jpeg&accept=image/png&accept=image/webp'
  assert.ok(member.split(' ').includes(blob))
  assert.ok(owner.split(' ').includes(blob))
  assert.equal(canUpload(member), true)
  assert.equal(canUpload('atproto space:x?authority=*'), false)
  assert.equal(canUpload('atproto blob:image/png'), false)
  assert.equal(canUpload('atproto blob:*/*'), true)
})

// ---------- reactions ----------

const { reactionFromRecord, paletteEmoji, REACTION_EMOJI } = await import('../../src/spaces.js')
const { canReact } = await import('../../src/oauth.js')
const MSG = (rkey) => `at://${OWNER}/com.example.parlor.message/${rkey}`

test('palette has 16 emoji and matches with or without the variation selector', () => {
  assert.equal(REACTION_EMOJI.length, 16)
  assert.equal(paletteEmoji('❤'), '❤️')
  assert.equal(paletteEmoji('❤️'), '❤️')
  assert.equal(paletteEmoji('🦄'), null)
  assert.equal(paletteEmoji(5), null)
})

test('reactionFromRecord needs a Parlor message subject and a palette emoji', () => {
  assert.deepEqual(reactionFromRecord({ subject: MSG('r1'), emoji: '👍' }), { subject: MSG('r1'), emoji: '👍' })
  assert.equal(reactionFromRecord({ subject: MSG('r1'), emoji: '🦄' }), null)
  assert.equal(reactionFromRecord({ subject: `at://${OWNER}/app.bsky.feed.post/r1`, emoji: '👍' }), null)
  assert.equal(reactionFromRecord({ subject: 'https://example.com', emoji: '👍' }), null)
  assert.equal(reactionFromRecord(null), null)
})

test('reactions are counted once per author and emoji, only on shown messages, only from writers', () => {
  const v = view()
  v.writers.add(OWNER)
  v.writers.add(OTHER)
  v.applyOps(OWNER, [op('r1', '1', { text: 'hi', createdAt: '2026-01-01T00:00:01Z' })])
  const rx = (rkey, emoji, subject = MSG('r1')) => ({
    collection: 'com.example.parlor.reaction', rkey, rev: '2', cid: 'bafy', value: { subject, emoji },
  })
  v.applyOps(OTHER, [rx('a', '👍'), rx('b', '👍'), rx('c', '🎲'), rx('d', '👍', MSG('gone'))])
  v.applyOps(OWNER, [rx('e', '👍')])
  let s = v.reactionSummary().get(MSG('r1'))
  assert.deepEqual(s.map((r) => [r.emoji, r.authors.length]), [['👍', 2], ['🎲', 1]])
  assert.equal(v.reactionSummary().has(MSG('gone')), false)
  assert.deepEqual(v.ownReactions(OTHER, MSG('r1'), '👍').sort(), ['a', 'b'])
  // Deleting a record removes it; removing a writer hides theirs.
  v.applyOps(OWNER, [{ collection: 'com.example.parlor.reaction', rkey: 'e', rev: '3', cid: null }])
  s = v.reactionSummary().get(MSG('r1'))
  assert.equal(s.find((r) => r.emoji === '👍').authors.length, 1)
  v.writers.delete(OTHER)
  v.dropRepo(OTHER)
  assert.equal(v.reactionSummary().has(MSG('r1')), false)
})

test('member scope includes the reaction collection and canReact reads it', () => {
  const { member } = scopes()
  assert.equal(canReact(member), true)
  assert.equal(canReact('atproto space:com.example.parlor.space?authority=*&collection=com.example.parlor.message'), false)
})

// End-to-end test against a running Parlor server and the Spaces sandbox.
// Signs in two sandbox accounts through the real OAuth pages with a headless
// browser, then exercises the API as each user.
//
// Env (from SANDBOX_ENV, default ../clockwork-conductor/spaces-sandbox-test/.env):
//   PLAYER_HANDLE, PLAYER_MAIN_PASSWORD, PLAYER_APP_PASSWORD  (space owner)
//   NONMEMBER_HANDLE, NONMEMBER_MAIN_PASSWORD, NONMEMBER_APP_PASSWORD (member)
//   PDS_URL
// Also: PARLOR_URL (default http://127.0.0.1:8790), BROWSER (path to Edge/Chrome)
//
// Cleanup deletes the test space and clears both accounts' records in it
// using app passwords.

import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const envFile = process.env.SANDBOX_ENV ?? new URL('../../clockwork-conductor/spaces-sandbox-test/.env', import.meta.url)
const sandbox = {}
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) sandbox[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const PARLOR = process.env.PARLOR_URL ?? 'http://127.0.0.1:8790'
const BROWSER = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PDS = sandbox.PDS_URL

const owner = { name: 'owner', handle: sandbox.PLAYER_HANDLE, password: sandbox.PLAYER_MAIN_PASSWORD, app: sandbox.PLAYER_APP_PASSWORD }
const member = { name: 'member', handle: sandbox.NONMEMBER_HANDLE, password: sandbox.NONMEMBER_MAIN_PASSWORD, app: sandbox.NONMEMBER_APP_PASSWORD }

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function signIn(browser, user, { host }) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(PARLOR)
  await page.fill('#handle', user.handle)
  if (host) await page.check('#owner')
  await page.click('#login-form button[type=submit]')
  await page.waitForURL((u) => u.origin !== new URL(PARLOR).origin, { timeout: 30000 })
  await page.waitForSelector('input[name=password]', { timeout: 30000 })
  const id = page.locator('input[name=identifier]')
  if (await id.isEditable()) await id.fill(user.handle)
  await page.fill('input[name=password]', user.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Consent screen: accept whatever the primary button is called.
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (page.url().startsWith(PARLOR)) break
    const accept = page.getByRole('button', { name: /^(Accept|Authorize|Allow|Continue)$/i })
    // The page may navigate away mid-check; that is expected.
    if (await accept.count().catch(() => 0)) {
      await accept.first().click().catch(() => {})
    }
    await sleep(1000)
  }
  if (!page.url().startsWith(PARLOR)) {
    const text = (await page.innerText('body').catch(() => '')).slice(0, 800)
    throw new Error(`${user.name}: sign-in did not return to Parlor. Page says:\n${text}`)
  }
  await page.waitForSelector('#who-handle', { state: 'visible', timeout: 20000 })
  const me = await page.evaluate(() => fetch('/api/me').then((r) => r.json()))
  return { context, page, me, user }
}

// API call from inside the user's browser page (same cookies, CSRF header).
async function call(u, path, { method = 'GET', body, csrf = true } = {}) {
  return u.page.evaluate(async ({ path, method, body, csrf, token }) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (method !== 'GET' && csrf) headers['x-csrf-token'] = token
    const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = {}
    try { data = await r.json() } catch { /* empty */ }
    return { status: r.status, data }
  }, { path, method, body, csrf, token: u.me.csrf })
}

async function waitFor(label, fn, timeoutMs = 45000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return { ok: true, ms: Date.now() - start, v }
    await sleep(1500)
  }
  return { ok: false, ms: Date.now() - start }
}

async function appSession(user) {
  const r = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: user.handle, password: user.app }),
  })
  return r.json()
}

async function appCall(sess, method, body) {
  const r = await fetch(`${PDS}/xrpc/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sess.accessJwt}` },
    body: JSON.stringify(body),
  })
  return `${r.status}`
}

const browser = await chromium.launch({ executablePath: BROWSER, headless: true })
let space = null
let A
let B
try {
  A = await signIn(browser, owner, { host: true })
  check('owner signs in with host scope', A.me.signedIn && A.me.host, A.me.handle)
  B = await signIn(browser, member, { host: false })
  check('member signs in with member scope', B.me.signedIn && !B.me.host, B.me.handle)

  // CSRF: a POST without the token is refused.
  const noCsrf = await call(A, '/api/spaces', { method: 'POST', body: { name: 'x' }, csrf: false })
  check('POST without CSRF token refused', noCsrf.status === 403, `${noCsrf.status} ${noCsrf.data.error}`)

  // Member scope cannot create spaces.
  const bCreate = await call(B, '/api/spaces', { method: 'POST', body: { name: 'nope' } })
  check('member-scope user cannot create a space', bCreate.status === 403, `${bCreate.status} ${bCreate.data.error}`)

  const created = await call(A, '/api/spaces', { method: 'POST', body: { name: 'E2E test room' } })
  check('owner creates a space', created.status === 200 && created.data.uri, created.data.uri ?? JSON.stringify(created.data))
  space = created.data.uri
  if (!space) throw new Error('no space; stopping')

  const aList = await call(A, '/api/spaces')
  check('space listed under Hosting', aList.data.owned?.some((s) => s.uri === space))

  const bEarly = await call(B, '/api/spaces/open', { method: 'POST', body: { invite: created.data.invite } })
  check('non-member cannot open the space by link', bEarly.status === 403, `${bEarly.status} ${bEarly.data.error}`)

  const add = await call(A, '/api/space/members', { method: 'POST', body: { uri: space, action: 'add', handle: member.handle } })
  check('owner adds member by handle', add.status === 200, `${add.status} ${add.data.handle ?? add.data.message}`)

  const members = await call(A, `/api/space/members?uri=${encodeURIComponent(space)}`)
  check('member list shows the member', members.data.members?.some((m) => m.handle === member.handle), JSON.stringify(members.data.members))

  const bMembers = await call(B, `/api/space/members?uri=${encodeURIComponent(space)}`)
  check('member cannot manage members', bMembers.status === 403, `${bMembers.status} ${bMembers.data.error}`)

  const bList = await call(B, '/api/spaces')
  check('member discovers the space under "Member of"', bList.data.member?.some((s) => s.uri === space && s.name === 'E2E test room'),
    JSON.stringify(bList.data.member))

  const bOpen = await call(B, '/api/spaces/open', { method: 'POST', body: { invite: created.data.invite } })
  check('member opens the space by link', bOpen.status === 200, `${bOpen.status} ${bOpen.data.message ?? bOpen.data.name}`)

  const tooLong = await call(B, '/api/space/message', { method: 'POST', body: { uri: space, text: 'x'.repeat(1001) } })
  check('over-length message refused', tooLong.status === 400, `${tooLong.status} ${tooLong.data.error}`)

  const html = '<img src=x onerror=alert(1)> **hi**'
  const t0 = Date.now()
  const pA = await call(A, '/api/space/message', { method: 'POST', body: { uri: space, text: 'Hello from the owner.' } })
  const pB = await call(B, '/api/space/message', { method: 'POST', body: { uri: space, text: `Hello from the member. ${html}` } })
  check('owner posts', pA.status === 200, `${pA.status} ${pA.data.message ?? ''}`)
  check('member posts', pB.status === 200, `${pB.status} ${pB.data.message ?? ''}`)

  const seenByA = await waitFor('A sees both', async () => {
    const r = await call(A, `/api/space?uri=${encodeURIComponent(space)}`)
    const t = (r.data.messages ?? []).map((m) => m.text)
    return t.includes('Hello from the owner.') && t.some((x) => x.startsWith('Hello from the member.'))
  })
  check('owner sees both messages', seenByA.ok, `${Date.now() - t0} ms after posting`)
  const seenByB = await waitFor('B sees both', async () => {
    const r = await call(B, `/api/space?uri=${encodeURIComponent(space)}`)
    const t = (r.data.messages ?? []).map((m) => m.text)
    return t.includes('Hello from the owner.') && t.some((x) => x.startsWith('Hello from the member.'))
  })
  check('member sees both messages', seenByB.ok, `${Date.now() - t0} ms after posting`)

  // UI renders text, not HTML.
  await A.page.reload()
  await A.page.waitForSelector('#who-handle', { state: 'visible' })
  await A.page.click(`button.space[data-uri="${space}"]`)
  await A.page.waitForSelector('#messages .msg', { timeout: 20000 })
  const rendered = await A.page.locator('#messages').innerText()
  const imgs = await A.page.locator('#messages img').count()
  check('UI shows messages as plain text', rendered.includes('<img src=x') && imgs === 0)
  await A.page.screenshot({ path: process.env.SCREENSHOT ?? 'test/e2e-owner.png', fullPage: true })

  // UI post path.
  await A.page.fill('#post-text', 'Posted from the page.')
  await A.page.click('#post-form button[type=submit]')
  const uiSeen = await waitFor('UI post', async () => (await A.page.locator('#messages').innerText()).includes('Posted from the page.'))
  check('owner posts from the page and sees it', uiSeen.ok, `${uiSeen.ms} ms`)

  // Removal: owner removes member; member's messages disappear for owner;
  // member loses access.
  const rm = await call(A, '/api/space/members', { method: 'POST', body: { uri: space, action: 'remove', did: B.me.did } })
  check('owner removes member', rm.status === 200, `${rm.status} ${rm.data.message ?? ''}`)
  const hidden = await waitFor('hidden', async () => {
    const r = await call(A, `/api/space?uri=${encodeURIComponent(space)}`)
    return r.data.messages && !r.data.messages.some((m) => m.text.startsWith('Hello from the member.'))
  })
  check("removed member's messages hidden from owner", hidden.ok, `${hidden.ms} ms`)
  const bPost = await call(B, '/api/space/message', { method: 'POST', body: { uri: space, text: 'Still here?' } })
  check('removed member cannot post', bPost.status === 403, `${bPost.status} ${bPost.data.error}`)
  const bRead = await waitFor('B loses read', async () => {
    const r = await call(B, `/api/space?uri=${encodeURIComponent(space)}`)
    return r.status === 403
  }, 90000)
  check('removed member loses read access', bRead.ok, `${bRead.ms} ms`)
  const bList2 = await call(B, '/api/spaces')
  check('space no longer under "Member of"', !bList2.data.member?.some((s) => s.uri === space))

  const out = await call(B, '/api/logout', { method: 'POST', body: {} })
  const after = await call(B, '/api/me')
  check('sign out ends the session', out.status === 200 && after.data.signedIn === false)
} catch (err) {
  fail++
  console.log(`FAIL  ${err.message}`)
} finally {
  if (space) {
    const sa = await appSession(owner)
    const sb = await appSession(member)
    const c1 = await appCall(sb, 'com.atproto.space.clearRecords', { space, repo: sb.did })
    const c2 = await appCall(sa, 'com.atproto.space.clearRecords', { space, repo: sa.did })
    const d = await appCall(sa, 'com.atproto.space.deleteSpace', { space })
    console.log(`cleanup: member clearRecords ${c1}, owner clearRecords ${c2}, deleteSpace ${d}`)
  }
  if (A) await call(A, '/api/logout', { method: 'POST', body: {} }).catch(() => {})
  await browser.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

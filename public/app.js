// Parlor browser client. Talks only to the Parlor server. All text from
// the network is inserted with textContent, never as HTML.

const $ = (id) => document.getElementById(id)
const POLL_MS = 3000

let me = null
let current = null // { uri, name, isOwner, version }
let pollTimer = null

function flash(text) {
  const el = $('flash')
  el.textContent = text ?? ''
  el.hidden = !text
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET' && me?.csrf) headers['x-csrf-token'] = me.csrf
  const res = await fetch(path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin',
  })
  let data = {}
  try { data = await res.json() } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401) showSignedOut()
    const err = new Error(data.message || data.error || `HTTP ${res.status}`)
    err.code = data.error
    throw err
  }
  return data
}

function el(tag, text, cls) {
  const e = document.createElement(tag)
  if (text !== undefined && text !== null) e.textContent = text
  if (cls) e.className = cls
  return e
}

function shortTime(iso) {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ---------- signed out ----------

function showSignedOut() {
  me = null
  stopPolling()
  $('signed-in').hidden = true
  $('who').hidden = true
  $('signed-out').hidden = false
}

$('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const handle = $('handle').value.trim().replace(/^@/, '')
  if (!handle) return
  const p = new URLSearchParams({ handle })
  if ($('owner').checked) p.set('owner', '1')
  // A plain navigation, so the redirect to the sign-in server is allowed.
  window.location.href = `/oauth/login?${p}`
})

// ---------- signed in ----------

async function showSignedIn() {
  $('signed-out').hidden = true
  $('signed-in').hidden = false
  $('who').hidden = false
  $('who-handle').textContent = me.handle
  $('create-form').hidden = !me.host
  $('host-hint').hidden = me.host
  await loadSpaces()
}

$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: {} }) } catch { /* ignore */ }
  showSignedOut()
})

function spaceItem(s, sub) {
  const li = el('li')
  const b = el('button', s.name || 'Unnamed space', 'space')
  b.type = 'button'
  b.dataset.uri = s.uri
  b.addEventListener('click', () => openSpace(s.uri, s.name))
  li.append(b)
  if (sub) li.append(el('span', sub, 'small'))
  if (current?.uri === s.uri) b.classList.add('active')
  return li
}

async function loadSpaces() {
  const data = await api('/api/spaces')
  const owned = $('owned')
  owned.replaceChildren(...data.owned.map((s) => spaceItem(s)))
  if (!data.owned.length) owned.append(el('li', 'None', 'small'))
  const member = $('member')
  member.replaceChildren(...data.member.map((s) => spaceItem(s, `hosted by ${s.owner}`)))
  if (!data.member.length) member.append(el('li', 'None', 'small'))
  const opened = $('opened')
  opened.replaceChildren(...data.opened.map((s) => spaceItem(s)))
  if (!data.opened.length) opened.append(el('li', 'None', 'small'))
  return data
}

$('create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  flash()
  try {
    const s = await api('/api/spaces', { method: 'POST', body: { name: $('create-name').value } })
    $('create-name').value = ''
    await loadSpaces()
    await openSpace(s.uri, s.name)
  } catch (err) { flash(err.message) }
})

$('open-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  flash()
  await openInvite($('open-invite').value)
  $('open-invite').value = ''
})

async function openInvite(invite, name) {
  try {
    const s = await api('/api/spaces/open', { method: 'POST', body: { invite, name } })
    await loadSpaces()
    await openSpace(s.uri, s.name)
  } catch (err) { flash(err.message) }
}

// ---------- chat ----------

async function openSpace(uri, name) {
  flash()
  stopPolling()
  current = { uri, name, version: -1, isOwner: false }
  fileNodes.clear()
  $('empty').hidden = true
  $('chat').hidden = false
  $('chat-name').textContent = name || 'Space'
  $('messages').replaceChildren(el('li', 'Loading…', 'small'))
  $('members').hidden = true
  $('chat-warning').hidden = true
  for (const b of document.querySelectorAll('#sidebar button.space')) b.classList.remove('active')
  await poll()
  await loadSpaces().catch(() => {})
}

async function poll() {
  if (!current) return
  const uri = current.uri
  try {
    const data = await api(`/api/space?${new URLSearchParams({ uri, v: String(current.version) })}`)
    if (!current || current.uri !== uri) return
    current.isOwner = data.isOwner
    $('members-toggle').hidden = !data.isOwner
    if (data.name) $('chat-name').textContent = data.name
    $('chat-warning').textContent = data.warning ?? ''
    $('chat-warning').hidden = !data.warning
    if (!data.unchanged) {
      current.version = data.version
      renderMessages(data.messages)
    }
  } catch (err) {
    flash(err.message)
    if (err.code === 'NoAccess') {
      current = null
      $('chat').hidden = true
      $('empty').hidden = false
      loadSpaces().catch(() => {})
      return
    }
  }
  schedulePoll()
}

function schedulePoll() {
  stopPolling()
  pollTimer = setTimeout(() => {
    if (document.hidden) schedulePoll()
    else poll()
  }, POLL_MS)
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && current) poll()
})

function renderMessages(messages) {
  const list = $('messages')
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
  if (!messages.length) {
    list.replaceChildren(el('li', 'No messages yet.', 'small'))
    fileNodes.clear()
    return
  }
  const used = new Set()
  list.replaceChildren(...messages.map((m) => {
    const li = el('li', undefined, m.mine ? 'msg mine' : 'msg')
    const head = el('div', undefined, 'msg-head')
    head.append(el('span', m.author, 'author'), el('time', shortTime(m.createdAt), 'small'))
    head.lastChild.dateTime = m.createdAt
    li.append(head)
    if (m.text) li.append(el('div', m.text, 'text'))
    if (m.file) li.append(cachedFileElement(m, used))
    return li
  }))
  for (const k of [...fileNodes.keys()]) if (!used.has(k)) fileNodes.delete(k)
  if (atBottom || current.version <= 1) list.scrollTop = list.scrollHeight
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Images inline (click opens full size); PDFs as a download link. URLs and
// names come from the Parlor server; names are set as text only.
function fileElement(f) {
  const box = el('div', undefined, 'msg-file')
  if (f.kind === 'image') {
    const a = el('a')
    a.href = f.url
    a.target = '_blank'
    a.rel = 'noopener'
    const img = el('img')
    img.src = f.url
    img.alt = f.name
    img.loading = 'lazy'
    img.decoding = 'async'
    a.append(img)
    box.append(a)
  } else {
    const a = el('a', `PDF: ${f.name} (${fmtSize(f.size)})`, 'pdf')
    a.href = f.url
    a.download = f.name
    box.append(a)
  }
  return box
}

// File elements already on the page, by message and file details. Files are
// served uncached, so reusing the element avoids downloading an image again
// on every refresh.
const fileNodes = new Map()
function cachedFileElement(m, used) {
  const f = m.file
  const key = JSON.stringify([m.uri, f.url, f.kind, f.name, f.size])
  used.add(key)
  let node = fileNodes.get(key)
  if (!node) {
    node = fileElement(f)
    fileNodes.set(key, node)
  }
  return node
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
function fileKind(file) {
  const ext = file.name.toLowerCase().split('.').pop()
  if (file.type === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (IMAGE_TYPES.includes(file.type) || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image'
  return null
}

function clearFile() {
  $('post-file').value = ''
  $('file-name').hidden = true
  $('file-clear').hidden = true
}

$('post-file').addEventListener('change', () => {
  const file = $('post-file').files[0]
  if (!file) return clearFile()
  if (!me?.canUpload) {
    clearFile()
    return flash('Sign out and sign in again to allow attaching files.')
  }
  const kind = fileKind(file)
  if (!kind) {
    clearFile()
    return flash('Only PNG, JPEG, GIF, WebP and PDF files can be attached.')
  }
  const max = kind === 'pdf' ? me.maxPdfBytes : me.maxImageBytes
  if (file.size > max) {
    clearFile()
    return flash(`That file is ${fmtSize(file.size)}. ${kind === 'pdf' ? 'PDFs' : 'Images'} are limited to ${fmtSize(max)}.`)
  }
  flash()
  $('file-name').textContent = `${file.name} (${fmtSize(file.size)})`
  $('file-name').hidden = false
  $('file-clear').hidden = false
})

$('file-clear').addEventListener('click', clearFile)

async function upload(uri, text, file) {
  const form = new FormData()
  form.append('uri', uri)
  form.append('text', text)
  form.append('file', file, file.name)
  const res = await fetch('/api/space/upload', {
    method: 'POST', body: form, credentials: 'same-origin', headers: { 'x-csrf-token': me.csrf },
  })
  let data = {}
  try { data = await res.json() } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401) showSignedOut()
    if (res.status === 413 && !data.message) throw new Error('That file is too large.')
    throw new Error(data.message || data.error || `HTTP ${res.status}`)
  }
  return data
}

$('post-text').addEventListener('input', updateCount)
function updateCount() {
  const n = [...$('post-text').value].length
  const max = me?.maxMessageLength ?? 1000
  $('count').textContent = `${n}/${max}`
  $('count').classList.toggle('warn', n > max)
}

$('post-text').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault()
    $('post-form').requestSubmit()
  }
})

$('post-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  if (!current) return
  const text = $('post-text').value.trim()
  const file = $('post-file').files[0]
  if (!text && !file) return
  const btn = ev.submitter ?? $('post-form').querySelector('button[type=submit]')
  btn.disabled = true
  flash()
  try {
    if (file) {
      flash(`Sending ${file.name}…`)
      await upload(current.uri, text, file)
      clearFile()
      flash()
    } else {
      await api('/api/space/message', { method: 'POST', body: { uri: current.uri, text } })
    }
    $('post-text').value = ''
    updateCount()
    await poll()
  } catch (err) {
    flash(err.message)
  } finally {
    btn.disabled = false
  }
})

// ---------- members (owner) ----------

$('members-toggle').addEventListener('click', async () => {
  const box = $('members')
  box.hidden = !box.hidden
  if (!box.hidden) await loadMembers()
})

async function loadMembers() {
  if (!current) return
  try {
    const data = await api(`/api/space/members?${new URLSearchParams({ uri: current.uri })}`)
    const list = $('member-list')
    list.replaceChildren(...data.members.map((m) => {
      const li = el('li', m.handle)
      const rm = el('button', 'Remove', 'link')
      rm.type = 'button'
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove ${m.handle} from this space?`)) return
        try {
          await api('/api/space/members', { method: 'POST', body: { uri: current.uri, action: 'remove', did: m.did } })
          await loadMembers()
        } catch (err) { flash(err.message) }
      })
      li.append(' ', rm)
      return li
    }))
    if (!data.members.length) list.append(el('li', 'No members yet.', 'small'))
    const link = new URL('/', window.location.href)
    link.searchParams.set('invite', current.uri)
    if (current.name) link.searchParams.set('name', current.name)
    $('invite-link').value = link.toString()
  } catch (err) { flash(err.message) }
}

$('add-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  flash()
  try {
    await api('/api/space/members', {
      method: 'POST', body: { uri: current.uri, action: 'add', handle: $('add-handle').value.trim() },
    })
    $('add-handle').value = ''
    await loadMembers()
  } catch (err) { flash(err.message) }
})

$('copy-invite').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('invite-link').value)
    flash('Invite link copied.')
  } catch {
    $('invite-link').select()
  }
})

// ---------- start ----------

async function start() {
  const params = new URLSearchParams(window.location.search)
  const error = params.get('error')
  const invite = params.get('invite')
  const inviteName = params.get('name')
  if (invite) {
    try { sessionStorage.setItem('parlor_invite', JSON.stringify({ invite, name: inviteName })) } catch { /* ignore */ }
  }
  if (error || invite) history.replaceState(null, '', '/')
  if (error) flash(error)

  try {
    me = await api('/api/me')
  } catch (err) {
    flash(err.message)
    me = { signedIn: false }
  }
  if (!me.signedIn) {
    if (invite) flash('Sign in to open the space you were invited to.')
    showSignedOut()
    return
  }
  await showSignedIn()
  let pending = null
  try {
    pending = JSON.parse(sessionStorage.getItem('parlor_invite') ?? 'null')
    sessionStorage.removeItem('parlor_invite')
  } catch { /* ignore */ }
  if (pending?.invite) await openInvite(pending.invite, pending.name)
}

start()

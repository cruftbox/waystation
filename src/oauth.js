// atproto OAuth client. Sessions (refresh tokens, DPoP keys) are stored
// encrypted in SQLite. Two scopes: members read and post; owners also
// create spaces and manage members.

import { NodeOAuthClient, buildAtprotoLoopbackClientMetadata } from '@atproto/oauth-client-node'
import { requestLocalLock } from '@atproto/oauth-client'
import { config, isLoopback } from './config.js'
import { kvStore } from './db.js'
import { FILE_TYPES } from './files.js'

// Two scope tokens: chat (read and post messages) and manage (create spaces,
// add and remove members). Members request only chat; hosts request both.
// The client metadata declares both, since a request must be a subset.
// Both also request upload permission for the attachment types.
export function scopes() {
  const chat = `space:${config.spaceType}?authority=*&collection=${config.messageCollection}&collection=${config.reactionCollection}`
  const manage = `space:${config.spaceType}?authority=*&manage=create&manage=update`
  const upload = `blob?${[...FILE_TYPES].sort().map((t) => `accept=${t}`).join('&')}`
  return {
    member: `atproto ${chat} ${upload}`,
    owner: `atproto ${chat} ${upload} ${manage}`,
  }
}

// Whether a granted scope string includes upload permission for every
// attachment type.
export function canUpload(granted) {
  const blob = String(granted ?? '').split(' ').find((s) => s === 'blob' || s.startsWith('blob:') || s.startsWith('blob?'))
  if (!blob) return false
  if (blob === 'blob:*/*') return true
  return FILE_TYPES.every((t) => blob.includes(t))
}

// Whether a granted scope string allows writing reactions.
export function canReact(granted) {
  return String(granted ?? '').split(' ').some((s) => s.startsWith(`space:${config.spaceType}?`)
    && s.split(/[?&]/).includes(`collection=${config.reactionCollection}`))
}

export const callbackPath = '/oauth/callback'

export function clientMetadata() {
  const { owner } = scopes()
  if (isLoopback) {
    // Development only: the authorization server accepts loopback clients
    // without hosted metadata.
    return buildAtprotoLoopbackClientMetadata({
      scope: owner,
      redirect_uris: [`${config.publicUrl}${callbackPath}`],
    })
  }
  return {
    client_id: `${config.publicUrl}/client-metadata.json`,
    client_name: 'Waystation',
    client_uri: config.publicUrl,
    redirect_uris: [`${config.publicUrl}${callbackPath}`],
    scope: owner,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
  }
}

export function makeOAuthClient(db, cipher) {
  return new NodeOAuthClient({
    clientMetadata: clientMetadata(),
    stateStore: kvStore(db, 'oauth_state', 15 * 60 * 1000, cipher),
    sessionStore: kvStore(db, 'oauth_session', null, cipher),
    requestLock: requestLocalLock,
  })
}

// atproto OAuth client. Sessions (refresh tokens, DPoP keys) are stored
// encrypted in SQLite. Two scopes: members read and post; owners also
// create spaces and manage members.

import { NodeOAuthClient, buildAtprotoLoopbackClientMetadata } from '@atproto/oauth-client-node'
import { requestLocalLock } from '@atproto/oauth-client'
import { config, isLoopback } from './config.js'
import { kvStore } from './db.js'

// Two scope tokens: chat (read and post messages) and manage (create spaces,
// add and remove members). Members request only chat; hosts request both.
// The client metadata declares both, since a request must be a subset.
export function scopes() {
  const chat = `space:${config.spaceType}?authority=*&collection=${config.messageCollection}`
  const manage = `space:${config.spaceType}?authority=*&manage=create&manage=update`
  return {
    member: `atproto ${chat}`,
    owner: `atproto ${chat} ${manage}`,
  }
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
    client_name: 'Parlor',
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

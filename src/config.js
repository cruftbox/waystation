// Configuration from environment variables. See .env.example.

import { readFileSync, existsSync } from 'node:fs'

// Minimal .env loader (KEY=VALUE lines, # comments). Real environment wins.
export function loadEnvFile(path = '.env') {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || line.trimStart().startsWith('#')) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}

loadEnvFile(process.env.WAYSTATION_ENV_FILE ?? '.env')

const env = process.env

function int(name, def) {
  const v = env[name]
  if (v === undefined || v === '') return def
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`)
  return n
}

export const config = {
  // Public base URL, no trailing slash. http://127.0.0.1:<port> selects the
  // atproto loopback (development) OAuth client.
  publicUrl: (env.PUBLIC_URL ?? `http://127.0.0.1:${int('PORT', 8790)}`).replace(/\/$/, ''),
  host: env.HOST ?? '127.0.0.1',
  port: int('PORT', 8790),
  dbPath: env.DB_PATH ?? './data/waystation.db',

  // Lexicon names. The space type needs a published declaration
  // (com.atproto.lexicon.schema record + _lexicon DNS TXT) or OAuth fails.
  spaceType: env.SPACE_TYPE ?? 'com.cruftmanor.waystation.space',
  messageCollection: env.MESSAGE_COLLECTION ?? 'com.cruftmanor.waystation.message',
  reactionCollection: env.REACTION_COLLECTION ?? 'com.cruftmanor.waystation.reaction',

  // Message length cap in characters (graphemes are close enough for a cap).
  maxMessageLength: int('MAX_MESSAGE_LENGTH', 1000),
  // Messages kept in memory per open space view.
  maxMessagesPerView: int('MAX_MESSAGES_PER_VIEW', 500),
  maxReactionsPerView: int('MAX_REACTIONS_PER_VIEW', 5000),
  // Seconds between full sweeps of all active writers (safety net).
  fullSweepSeconds: int('FULL_SWEEP_SECONDS', 60),
  // Minimum seconds between syncs for the same user and space.
  minSyncSeconds: int('MIN_SYNC_SECONDS', 2),

  // Web session lifetime (days) and idle timeout of open views (minutes).
  sessionDays: int('SESSION_DAYS', 14),
  viewIdleMinutes: int('VIEW_IDLE_MINUTES', 15),

  // Rate limits per signed-in user, per minute.
  postsPerMinute: int('POSTS_PER_MINUTE', 20),
  requestsPerMinute: int('REQUESTS_PER_MINUTE', 240),
  manageActionsPerMinute: int('MANAGE_PER_MINUTE', 30),
  uploadsPerMinute: int('UPLOADS_PER_MINUTE', 5),
  reactionsPerMinute: int('REACTIONS_PER_MINUTE', 30),
  // Attachment size caps in bytes. Both stay under the server-wide
  // mod_security request body limit (12.5 MB) on cruftmanor.com.
  maxImageBytes: int('MAX_IMAGE_BYTES', 12 * 1024 * 1024),
  maxPdfBytes: int('MAX_PDF_BYTES', 12 * 1024 * 1024),
  // Image thumbnails, made by the poster's browser and shown in the chat.
  maxThumbBytes: int('MAX_THUMB_BYTES', 256 * 1024),
  // Spaces a single user may create through Waystation.
  maxSpacesPerOwner: int('MAX_SPACES_PER_OWNER', 20),

  // 64 hex chars. Encrypts OAuth sessions at rest. Required.
  sessionKey: env.SESSION_KEY ?? '',

  // Tests only: allow http and private hosts for outbound calls.
  allowInsecureHosts: env.ALLOW_INSECURE_HOSTS === '1',

  // PLC directory for did:plc resolution.
  plcUrl: (env.PLC_URL ?? 'https://plc.directory').replace(/\/$/, ''),

  // Optional comma-separated list of DIDs allowed to sign in. Empty: anyone.
  allowedDids: (env.ALLOWED_DIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
}

export const isLoopback = /^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?$/.test(config.publicUrl)

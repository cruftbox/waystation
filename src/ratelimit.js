// Fixed-window rate limiter, per key, per minute.

export class RateLimitError extends Error {
  constructor() {
    super('Too many requests; slow down.')
    this.status = 429
    this.code = 'RateLimited'
  }
}

export class RateLimiter {
  constructor() {
    this.windows = new Map() // key -> { start, count }
  }

  hit(key, perMinute) {
    const now = Date.now()
    let w = this.windows.get(key)
    if (!w || now - w.start >= 60000) {
      w = { start: now, count: 0 }
      this.windows.set(key, w)
    }
    w.count++
    if (w.count > perMinute) throw new RateLimitError()
  }

  sweep() {
    const now = Date.now()
    for (const [k, w] of this.windows) if (now - w.start >= 60000) this.windows.delete(k)
  }
}

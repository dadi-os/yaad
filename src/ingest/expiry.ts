/** Compute expires_at from an anchor instant and a positive TTL in days. */
export function computeExpiresAt(anchor: Date, ttlDays: number): Date {
  return new Date(anchor.getTime() + ttlDays * 86_400_000);
}

export function isExpired(expiresAt: Date | null, now = new Date()): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

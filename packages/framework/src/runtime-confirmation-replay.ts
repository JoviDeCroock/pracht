const usedTokens = new Map<string, number>();

/**
 * Mark a token as used. Returns false when it was already consumed on this
 * instance. Expired entries are swept opportunistically so the map cannot
 * grow past the confirmation TTL's working set.
 */
export function consumeConfirmationToken(signature: string, expiresAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (usedTokens.size > 0) {
    for (const [used, expiry] of usedTokens) {
      if (expiry < now) usedTokens.delete(used);
    }
  }
  if (usedTokens.has(signature)) return false;
  usedTokens.set(signature, expiresAt);
  return true;
}

/** Test hook — clears the single-use cache. */
export function clearConsumedConfirmationTokens(): void {
  usedTokens.clear();
}

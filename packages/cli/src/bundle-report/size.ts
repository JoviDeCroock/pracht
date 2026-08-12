const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/;

/**
 * Parse a size budget value into bytes. Accepts plain numbers (bytes) or size
 * strings such as "120kb" and "1mb" using 1024-based units.
 */
export function parseSizeToBytes(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Invalid size ${JSON.stringify(value)}: expected a positive number of bytes.`,
      );
    }
    return Math.floor(value);
  }

  const match = SIZE_RE.exec(value.trim().toLowerCase());
  if (!match) {
    throw new Error(
      `Invalid size ${JSON.stringify(value)}: expected a byte count or a size string like "120kb" or "1mb".`,
    );
  }

  const amount = Number.parseFloat(match[1]);
  const bytes = Math.round(amount * SIZE_UNITS[match[2] ?? "b"]);
  if (bytes <= 0) {
    throw new Error(`Invalid size ${JSON.stringify(value)}: expected a positive size.`);
  }
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}kb`;
  return `${(kb / 1024).toFixed(2)}mb`;
}

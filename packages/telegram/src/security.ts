import { createHash, timingSafeEqual } from "node:crypto"

/**
 * Compare secrets without exposing length or prefix timing differences.
 * Hashing first ensures timingSafeEqual always receives fixed-length buffers.
 */
export function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest()
  const rightHash = createHash("sha256").update(right, "utf8").digest()
  return timingSafeEqual(leftHash, rightHash)
}

/** Missing configuration must fail closed; never accept an empty secret. */
export function verifyWebhookSecret(header: string | null, expected: string): boolean {
  if (!header || !expected) return false
  return safeEqual(header, expected)
}

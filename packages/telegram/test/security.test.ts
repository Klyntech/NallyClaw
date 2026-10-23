import { expect, test } from "bun:test"
import { safeEqual, verifyWebhookSecret } from "../src/security"

test("safeEqual accepts identical strings and rejects different strings", () => {
  expect(safeEqual("secret-value", "secret-value")).toBe(true)
  expect(safeEqual("secret-value", "secret-value!")).toBe(false)
  expect(safeEqual("secret-value", "other-value")).toBe(false)
})

test("webhook validation fails closed for missing configuration or header", () => {
  expect(verifyWebhookSecret(null, "configured-secret")).toBe(false)
  expect(verifyWebhookSecret("", "configured-secret")).toBe(false)
  expect(verifyWebhookSecret("configured-secret", "")).toBe(false)
  expect(verifyWebhookSecret("configured-secret", "configured-secret")).toBe(true)
  expect(verifyWebhookSecret("wrong-secret", "configured-secret")).toBe(false)
})

import { spawn } from "node:child_process"
import { timingSafeEqual } from "node:crypto"
import { voicePage } from "./voice-page"
import { createTelegramWebhook, type TelegramProgressReporter, type TelegramTextMessage } from "./webhook"
import { selectedModel } from "./model-config"
import { buildConversationContext } from "../../core/src/nally-memory/retrieval"
import {
  waitForAssistantMessage,
  AssistantWaitTimeoutError,
  DEFAULT_ASSISTANT_TIMEOUT_MS,
  VOICE_ASSISTANT_TIMEOUT_MS,
  DEFAULT_STAGNATION_MS,
} from "./wait-for-response"
import { checkMemoryDatabase, getRecentConversationTurns, getTelegramSession, saveConversationTurn, saveTelegramSession, searchConversationTurns } from "../../core/src/nally-memory/store"

// FILE TOO LARGE FOR SINGLE TOOL ARG - will use multi-step

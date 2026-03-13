/**
 * SCORM Chamilo Generator — Telegram Bot
 * 
 * Modular entry point. All logic is in tools/bot/ submodules.
 * Supports: Long Polling mode.
 */
import { BOT_TOKEN, POLL_TIMEOUT_SECONDS, RETRY_DELAY_MS, sleep, errorMessage } from "./bot/config.mjs";
import { telegramCall } from "./bot/api.mjs";
import { loadState, saveState, botState } from "./bot/state.mjs";
import { handleMessage } from "./bot/handlers/message.mjs";
import { handleCallbackQuery } from "./bot/handlers/callback.mjs";

let stopped = false;

async function getUpdates(offset) {
  return telegramCall(
    "getUpdates",
    { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ["message", "callback_query"] },
    { timeoutSeconds: POLL_TIMEOUT_SECONDS + 10 }
  );
}

async function run() {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required.");

  // Bootstrap: verify token
  let me = null;
  while (!stopped) {
    try {
      me = await telegramCall("getMe", {});
      break;
    } catch (error) {
      console.error(`[bot] bootstrap error: ${errorMessage(error, "unknown")}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  if (!me) return;
  console.log(`[bot] started as @${me?.username || "unknown"} (${me?.id || "n/a"})`);

  // Load persisted state
  await loadState();
  let offset = botState.offset;
  if (offset > 0) console.log(`[bot] resume offset: ${offset}`);

  // Main polling loop
  while (!stopped) {
    try {
      const updates = await getUpdates(offset);
      if (!Array.isArray(updates) || updates.length === 0) continue;

      for (const update of updates) {
        const updateId = Math.trunc(Number(update?.update_id));
        if (Number.isFinite(updateId)) offset = Math.max(offset, updateId + 1);

        try {
          if (update?.message) {
            await handleMessage(update.message);
          } else if (update?.callback_query) {
            await handleCallbackQuery(update.callback_query);
          }
        } catch (err) {
          console.error(`[bot] update error ${updateId}:`, err?.message || err);
          // Offset is already advanced — this update will NOT replay
        }
      }

      botState.offset = offset;
      await saveState();
    } catch (error) {
      console.error(`[bot] polling error: ${errorMessage(error, "unknown")}`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  botState.offset = offset;
  await saveState().catch(() => {});
  console.log("[bot] stopped");
}

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopped = true;
    console.log(`[bot] received ${signal}, shutting down...`);
    process.exit(0);
  });
}

run().catch((error) => {
  console.error(`[bot] fatal: ${errorMessage(error, "unknown")}`);
  process.exit(1);
});

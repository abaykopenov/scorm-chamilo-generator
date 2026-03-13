import { spawn } from "node:child_process";
import { loadLocalEnvFiles } from "./load-env.mjs";

loadLocalEnvFiles();

function isTruthy(value, fallback = false) {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return !["0", "false", "off", "no"].includes(normalized);
}

function resolveNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function resolveMode(rawMode) {
  return rawMode === "start" ? "start" : "dev";
}

function resolveMainProcessArgs(mode) {
  if (mode === "start") {
    return ["run", "start:next"];
  }
  return ["run", "dev:clean"];
}

function shouldRunTelegramBot() {
  const enabled = isTruthy(process.env.TELEGRAM_BOT_ENABLED, true);
  const hasToken = `${process.env.TELEGRAM_BOT_TOKEN || ""}`.trim().length > 0;
  return enabled && hasToken;
}

function createChild(command, args, label) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: true
  });
  child.on("error", (error) => {
    console.error(`[run-with-bot] ${label} process error:`, error instanceof Error ? error.message : error);
  });
  return child;
}

const mode = resolveMode(process.argv[2]);
const npmCommand = resolveNpmCommand();
const mainArgs = resolveMainProcessArgs(mode);

const mainProcess = createChild(npmCommand, mainArgs, "service");

let botProcess = null;
if (shouldRunTelegramBot()) {
  botProcess = createChild(`"${process.execPath}"`, ["tools/telegram-bot.mjs"], "telegram-bot");
  console.log("[run-with-bot] Telegram bot enabled.");
} else {
  console.log("[run-with-bot] Telegram bot disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_ENABLED=true to enable).");
}

let shuttingDown = false;

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (botProcess && !botProcess.killed) {
    botProcess.kill(signal);
  }
  if (mainProcess && !mainProcess.killed) {
    mainProcess.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

mainProcess.on("exit", (code, signal) => {
  if (botProcess && !botProcess.killed) {
    botProcess.kill("SIGTERM");
  }
  if (signal) {
    process.exit(0);
    return;
  }
  process.exit(code ?? 0);
});

if (botProcess) {
  botProcess.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    if (signal) {
      console.warn(`[run-with-bot] Telegram bot stopped by signal ${signal}.`);
      return;
    }
    if ((code ?? 0) !== 0) {
      console.warn(`[run-with-bot] Telegram bot exited with code ${code}. Service keeps running.`);
    }
  });
}

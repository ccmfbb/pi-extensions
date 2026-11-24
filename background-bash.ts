/** Minimal non-blocking bash extension with steer-to-detach and metadata-only exit notices. */

import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { constants as operatingSystemConstants, tmpdir as temporaryDirectory } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, getShellConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXTENSION_KEY = "background-bash";

interface ActiveJob {
  processIdentifier: number;
  detach?: () => void;
}

/** Kill a detached process group, falling back to the single process identifier. */
function killProcessGroup(processIdentifier: number): void {
  try {
    process.kill(-processIdentifier, "SIGKILL");
  } catch {
    try {
      process.kill(processIdentifier, "SIGKILL");
    } catch {}
  }
}

/** Read the bounded tail of a log file without loading oversized files into memory. */
function readLogTail(logPath: string, maximumBytes: number): { text: string; truncated: boolean } {
  const fileSize = statSync(logPath).size;
  if (fileSize === 0) return { text: "", truncated: false };
  const bytesToRead = Math.min(fileSize, maximumBytes);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const fileDescriptor = openSync(logPath, "r");
  const bytesRead = readSync(fileDescriptor, buffer, 0, bytesToRead, fileSize - bytesToRead);
  closeSync(fileDescriptor);
  const rawText = buffer.subarray(0, bytesRead).toString("utf8");
  const truncated = fileSize > maximumBytes;
  const text = truncated ? `${rawText.slice(rawText.indexOf("\n") + 1)}\n\n[Truncated. Full log: ${logPath}]` : rawText;
  return { text, truncated };
}

/** Register the minimal non-blocking bash tool on Pi. */
export default function backgroundBashExtension(pi: ExtensionAPI): void {
  const activeJobs = new Map<string, ActiveJob>();
  const pendingCompletions: string[] = [];
  let nextJobNumber = 1;
  let shuttingDown = false;
  let activeContext: ExtensionContext | undefined;

  const flushCompleted = (): void => {
    if (shuttingDown || pendingCompletions.length === 0) return;
    const lines = pendingCompletions.splice(0);
    const content = `Background job${lines.length > 1 ? "s" : ""} finished:\n${lines.join("\n")}\nUse read on the log file to inspect output.`;
    pi.sendMessage({ customType: EXTENSION_KEY, content, display: true }, { triggerTurn: true });
  };

  pi.on("session_start", async (_event, context) => {
    shuttingDown = false;
    activeContext = context;
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    for (const job of activeJobs.values()) killProcessGroup(job.processIdentifier);
    activeJobs.clear();
    pendingCompletions.length = 0;
    activeContext = undefined;
  });

  pi.on("input", async (event, context) => {
    activeContext = context;
    if (event.source !== "extension" && event.streamingBehavior === "steer") {
      setImmediate(() => {
        for (const job of activeJobs.values()) job.detach?.();
      });
    }
    return { action: "continue" };
  });

  pi.on("agent_settled", async (event, context) => {
    activeContext = context;
    if (event.aborted) pendingCompletions.length = 0;
    else flushCompleted();
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: "Execute a bash command in the current working directory. Runs inline by default, detaches to background on user input, or starts in background with background: true.",
    promptSnippet: "Execute bash commands (supports background: true and live user detach)",
    promptGuidelines: ["Pass background: true on bash for long-running commands; completion notices contain only metadata—use read on the log file to inspect output and kill -- -<pid> to stop."],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      background: Type.Optional(Type.Boolean({ description: "Start in the background immediately" })),
    }),

    async execute(_toolCallIdentifier, parameters, signal, _onUpdate, context) {
      activeContext = context;
      if (signal?.aborted) return { content: [{ type: "text", text: "Command aborted" }], details: undefined, isError: true };

      const settings = pi.getSettings();
      const shellConfiguration = getShellConfig(settings.shellPath);
      const resolvedCommand = settings.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${parameters.command}` : parameters.command;
      const identifier = `job-${nextJobNumber++}`;
      const logPath = join(temporaryDirectory(), `pi-bash-${process.pid}-${identifier}.log`);
      const fileDescriptor = openSync(logPath, "w");
      const child = spawn(shellConfiguration.shell, [...shellConfiguration.args, resolvedCommand], { cwd: context.cwd, detached: true, stdio: ["ignore", fileDescriptor, fileDescriptor] });
      closeSync(fileDescriptor);

      const job: ActiveJob = { processIdentifier: child.pid ?? 0 };
      activeJobs.set(identifier, job);

      return new Promise((resolve) => {
        let settled = false;
        let aborted = false;

        const finishInline = (text: string, isError: boolean, fullOutputPath?: string): void => {
          if (settled) return;
          settled = true;
          job.detach = undefined;
          signal?.removeEventListener("abort", onAbort);
          resolve({ content: [{ type: "text", text }], details: fullOutputPath ? { fullOutputPath } : undefined, isError });
        };

        const detach = (prefix: string): void => {
          job.processIdentifier = child.pid ?? job.processIdentifier;
          finishInline(`${prefix} background as ${identifier} (pid ${job.processIdentifier}).\nLog: ${logPath}`, false, logPath);
        };

        const onAbort = (): void => {
          aborted = true;
          activeJobs.delete(identifier);
          killProcessGroup(job.processIdentifier);
          const snapshot = readLogTail(logPath, DEFAULT_MAX_BYTES);
          if (!snapshot.truncated) try { unlinkSync(logPath); } catch {}
          finishInline(snapshot.text ? `${snapshot.text}\n\nCommand aborted` : "Command aborted", true, snapshot.truncated ? logPath : undefined);
        };

        signal?.addEventListener("abort", onAbort, { once: true });
        if (parameters.background) child.once("spawn", () => detach("Running in"));
        else job.detach = () => detach("Moved to");

        child.once("error", (error) => {
          activeJobs.delete(identifier);
          try { unlinkSync(logPath); } catch {}
          finishInline(`Failed to start command: ${error.message}`, true);
        });

        child.once("exit", (code, signalCode) => {
          activeJobs.delete(identifier);
          const signalNumber = signalCode ? (operatingSystemConstants.signals[signalCode] ?? 0) : 0;
          const exitCode = code ?? (signalNumber ? 128 + signalNumber : 1);

          if (!settled) {
            const snapshot = readLogTail(logPath, DEFAULT_MAX_BYTES);
            if (!snapshot.truncated) try { unlinkSync(logPath); } catch {}
            const text = exitCode !== 0 ? `${snapshot.text ? `${snapshot.text}\n\n` : ""}Command exited with code ${exitCode}` : snapshot.text || "(no output)";
            return finishInline(text, exitCode !== 0, snapshot.truncated ? logPath : undefined);
          }

          if (shuttingDown || aborted) return;
          pendingCompletions.push(`- ${identifier} (exit ${exitCode}) — ${parameters.command.replace(/\s+/g, " ").trim().slice(0, 120)} — Log: ${logPath}`);
          if (activeContext?.isIdle()) flushCompleted();
        });
      });
    },
  });
}

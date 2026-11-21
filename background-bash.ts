/** Always-background bash extension with a 2-second inline grace window and exit cleanup. */

import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { constants as operatingSystemConstants, tmpdir as temporaryDirectory } from "node:os";
import { join } from "node:path";
import type { BashToolDetails, ExtensionAPI, ExtensionContext, TruncationResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getShellConfig, truncateTail } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXTENSION_KEY = "background-bash";
const GRACE_MILLISECONDS = 2_000;
const KILL_ESCALATION_MILLISECONDS = 200;
const STATUS_INTERVAL_MILLISECONDS = 1_000;
const MAXIMUM_LOG_READ_BYTES = DEFAULT_MAX_BYTES * 2;
const PARTIAL_PREVIEW_LINES = 20;

type JobStatus = "running" | "exited" | "timed_out" | "killed" | "failed";

interface BackgroundJob {
  identifier: string;
  command: string;
  processIdentifier: number;
  logPath: string;
  startedAt: number;
  endedAt?: number;
  status: JobStatus;
  exitCode?: number;
  timeoutSeconds?: number;
  backgrounded: boolean;
  silent: boolean;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

interface CompletionDetails {
  job: string;
  command: string;
  status: JobStatus;
  exitCode: number;
  durationSeconds: number;
  logPath: string;
  output: string;
}

interface LogSnapshot {
  text: string;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/** Kill a detached process group, falling back to the single process identifier. */
function killProcessGroup(processIdentifier: number, signalName: NodeJS.Signals): void {
  try {
    process.kill(-processIdentifier, signalName);
  } catch {
    try {
      process.kill(processIdentifier, signalName);
    } catch {}
  }
}

/** Format an elapsed duration in compact human-readable form. */
function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds / 1000);
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = Math.floor(totalSeconds % 60);
  return `${minutes}m${remainingSeconds}s`;
}

/** Read the tail of a job log file without loading oversized files into memory. */
function readLogTail(logPath: string, maximumLines: number): LogSnapshot {
  const fileSize = statSync(logPath).size;
  if (fileSize === 0) return { text: "" };

  const bytesToRead = Math.min(fileSize, MAXIMUM_LOG_READ_BYTES);
  const startOffset = fileSize - bytesToRead;
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const fileDescriptor = openSync(logPath, "r");
  const bytesRead = readSync(fileDescriptor, buffer, 0, bytesToRead, startOffset);
  closeSync(fileDescriptor);

  let rawText = buffer.subarray(0, bytesRead).toString("utf8");
  if (startOffset > 0) {
    const firstNewlineIndex = rawText.indexOf("\n");
    if (firstNewlineIndex !== -1) rawText = rawText.slice(firstNewlineIndex + 1);
  }

  const truncation = truncateTail(rawText, { maxLines: maximumLines, maxBytes: DEFAULT_MAX_BYTES });
  const isTruncated = truncation.truncated || startOffset > 0;
  if (!isTruncated) return { text: truncation.content };

  const suffix = `\n\n[Showing last ${truncation.outputLines} lines (${formatSize(truncation.outputBytes)}). Full output: ${logPath}]`;
  return {
    text: `${truncation.content}${suffix}`,
    truncation: { ...truncation, truncated: true },
    fullOutputPath: logPath,
  };
}

/** Build the child shell environment with Pi session metadata variables. */
function buildShellEnvironment(context: ExtensionContext, thinkingLevel: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.PI_SESSION_ID;
  delete environment.PI_SESSION_FILE;
  delete environment.PI_PROVIDER;
  delete environment.PI_MODEL;
  delete environment.PI_REASONING_LEVEL;

  environment.PI_SESSION_ID = context.sessionManager.getSessionId();
  const sessionFile = context.sessionManager.getSessionFile();
  if (sessionFile) environment.PI_SESSION_FILE = sessionFile;
  if (context.model) {
    environment.PI_PROVIDER = context.model.provider;
    environment.PI_MODEL = context.model.id;
  }
  if (thinkingLevel) environment.PI_REASONING_LEVEL = thinkingLevel;
  return environment;
}

/** Format a one-line summary for a background job. */
function formatJobSummary(job: BackgroundJob): string {
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
  const state = job.status === "exited" ? `exit ${job.exitCode}` : job.status;
  const singleLineCommand = job.command.replace(/\s+/g, " ").trim();
  const displayCommand = singleLineCommand.length > 72 ? `${singleLineCommand.slice(0, 69)}...` : singleLineCommand;
  return `${job.identifier}  ${state}  ${elapsed}  ${displayCommand}`;
}

/** Format a job's status header and output tail for tool results and notifications. */
function formatJobReport(job: BackgroundJob, snapshot: LogSnapshot): string {
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
  const outcome =
    job.status === "running"
      ? `running for ${elapsed}`
      : job.status === "timed_out"
        ? `timed out after ${job.timeoutSeconds}s`
        : job.status === "killed"
          ? `killed after ${elapsed}`
          : `exited with code ${job.exitCode} in ${elapsed}`;
  const header = `[${job.identifier} ${outcome}]\n$ ${job.command}\nLog: ${job.logPath}`;
  return snapshot.text ? `${header}\n\n${snapshot.text}` : `${header}\n\n(no output)`;
}

/** Register the always-background bash extension on Pi. */
export default function backgroundBashExtension(pi: ExtensionAPI): void {
  const jobs = new Map<string, BackgroundJob>();
  let nextJobNumber = 1;
  let shuttingDown = false;
  let statusVisible = false;
  let activeContext: ExtensionContext | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const runningJobs = (): BackgroundJob[] => [...jobs.values()].filter((job) => job.status === "running" && job.backgrounded);

  const stopRefreshTimer = (): void => {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  };

  const renderStatus = (): void => {
    const running = runningJobs();
    if (running.length === 0) stopRefreshTimer();
    if (!activeContext?.hasUI) return;

    if (running.length === 0) {
      if (!statusVisible) return;
      statusVisible = false;
      activeContext.ui.setStatus(EXTENSION_KEY, undefined);
      activeContext.ui.setWidget(EXTENSION_KEY, undefined);
      return;
    }

    statusVisible = true;
    const theme = activeContext.ui.theme;
    const label = running.length === 1 ? "1 job" : `${running.length} jobs`;
    activeContext.ui.setStatus(EXTENSION_KEY, theme.fg("accent", "⏵") + theme.fg("dim", ` ${label}`));
    const widgetLines = running.slice(0, 3).map((job) => theme.fg("accent", "⏵ ") + theme.fg("dim", formatJobSummary(job)));
    if (running.length > 3) widgetLines.push(theme.fg("muted", `  ... and ${running.length - 3} more (/jobs)`));
    activeContext.ui.setWidget(EXTENSION_KEY, widgetLines);
  };

  const ensureRefreshTimer = (): void => {
    if (refreshTimer) return;
    refreshTimer = setInterval(renderStatus, STATUS_INTERVAL_MILLISECONDS);
    refreshTimer.unref();
  };

  const stopJob = (job: BackgroundJob, silent: boolean): void => {
    if (job.status !== "running") return;
    job.silent = silent;
    job.status = "killed";
    job.endedAt = Date.now();
    if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
    killProcessGroup(job.processIdentifier, "SIGTERM");
    setTimeout(() => killProcessGroup(job.processIdentifier, "SIGKILL"), KILL_ESCALATION_MILLISECONDS).unref();
    renderStatus();
  };

  const killAllJobs = (): void => {
    shuttingDown = true;
    stopRefreshTimer();
    for (const job of jobs.values()) {
      if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
      if (job.status === "running") killProcessGroup(job.processIdentifier, "SIGKILL");
    }
    jobs.clear();
    if (statusVisible && activeContext?.hasUI) {
      statusVisible = false;
      activeContext.ui.setStatus(EXTENSION_KEY, undefined);
      activeContext.ui.setWidget(EXTENSION_KEY, undefined);
    }
  };

  pi.on("session_start", async (_event, context) => {
    shuttingDown = false;
    activeContext = context;
    renderStatus();
  });

  pi.on("session_shutdown", async () => {
    killAllJobs();
    activeContext = undefined;
  });

  pi.registerMessageRenderer<CompletionDetails>(EXTENSION_KEY, (message, options, theme) => {
    const details = message.details;
    const succeeded = details.status === "exited" && details.exitCode === 0;
    const icon = succeeded ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const state = details.status === "exited" ? `exit ${details.exitCode}` : details.status;
    const headline = `${icon} ${theme.bold(details.job)} ${theme.fg("dim", `${state} (${details.durationSeconds}s)`)} ${theme.fg("accent", details.command.replace(/\s+/g, " ").trim())}`;

    if (!options.expanded) {
      const hint = theme.fg("muted", ` (${options.keyHint("app.tools.expand", "to expand")})`);
      return new Text(`${headline}${hint}`, options.outputPad, 0);
    }

    const body = details.output ? `\n${theme.fg("toolOutput", details.output)}` : "";
    const footer = `\n${theme.fg("muted", `Log: ${details.logPath}`)}`;
    return new Text(`${headline}${body}${footer}`, options.outputPad, 0);
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the current working directory. Commands finishing within 2 seconds return output directly; longer commands move to the background automatically and notify you when they finish. Optionally provide a timeout in seconds.",
    promptSnippet: "Execute bash commands (auto-backgrounds after 2s)",
    promptGuidelines: [
      "You can inspect PI_* environment variables for current model and session details.",
      "Long-running bash commands move to the background after 2 seconds and wake you on exit; do not poll in a sleep loop—use bash_output only when you need intermediate progress and bash_kill to stop a job.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
    }),

    async execute(_toolCallIdentifier, parameters, signal, _onUpdate, context) {
      activeContext = context;
      if (signal?.aborted) return { content: [{ type: "text", text: "Command aborted" }], details: undefined, isError: true };

      const settings = pi.getSettings();
      const shellConfiguration = getShellConfig(settings.shellPath);
      const resolvedCommand = settings.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${parameters.command}` : parameters.command;
      const identifier = `job-${nextJobNumber++}`;
      const logPath = join(temporaryDirectory(), `pi-background-${process.pid}-${identifier}.log`);
      const fileDescriptor = openSync(logPath, "w");
      const child = spawn(shellConfiguration.shell, [...shellConfiguration.args, resolvedCommand], {
        cwd: context.cwd,
        detached: true,
        env: buildShellEnvironment(context, pi.getThinkingLevel()),
        stdio: ["ignore", fileDescriptor, fileDescriptor],
      });
      closeSync(fileDescriptor);

      const job: BackgroundJob = {
        identifier,
        command: parameters.command,
        processIdentifier: child.pid ?? 0,
        logPath,
        startedAt: Date.now(),
        status: "running",
        timeoutSeconds: parameters.timeout,
        backgrounded: false,
        silent: false,
      };
      jobs.set(identifier, job);

      if (parameters.timeout !== undefined && parameters.timeout > 0) {
        job.timeoutHandle = setTimeout(() => {
          if (job.status !== "running") return;
          job.status = "timed_out";
          killProcessGroup(job.processIdentifier, "SIGKILL");
        }, parameters.timeout * 1000);
        job.timeoutHandle.unref();
      }

      return new Promise((resolve) => {
        let settled = false;

        const finishInline = (text: string, details: BashToolDetails | undefined, isError: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(graceHandle);
          signal?.removeEventListener("abort", onAbort);
          resolve({ content: [{ type: "text", text }], details, isError });
        };

        const onAbort = (): void => {
          job.silent = true;
          job.status = "killed";
          job.endedAt = Date.now();
          if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
          killProcessGroup(job.processIdentifier, "SIGKILL");
          jobs.delete(identifier);
          const snapshot = readLogTail(logPath, DEFAULT_MAX_LINES);
          const message = snapshot.text ? `${snapshot.text}\n\nCommand aborted` : "Command aborted";
          finishInline(message, { truncation: snapshot.truncation, fullOutputPath: snapshot.fullOutputPath }, true);
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        const graceHandle = setTimeout(() => {
          if (settled || job.status !== "running") return;
          job.backgrounded = true;
          ensureRefreshTimer();
          renderStatus();
          const snapshot = readLogTail(logPath, PARTIAL_PREVIEW_LINES);
          const header = `Running in background as ${identifier} (pid ${job.processIdentifier}).\nLog: ${logPath}\nYou will be notified when it finishes. Use bash_output to inspect or bash_kill to stop.`;
          const text = snapshot.text ? `${header}\n\n${snapshot.text}` : header;
          finishInline(text, { fullOutputPath: logPath }, false);
        }, GRACE_MILLISECONDS);

        child.once("error", (error) => {
          if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
          job.status = "failed";
          job.endedAt = Date.now();
          jobs.delete(identifier);
          try {
            unlinkSync(logPath);
          } catch {}
          finishInline(`Failed to start command: ${error.message}`, undefined, true);
        });

        child.once("exit", (code, signalCode) => {
          if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
          const signalNumber = signalCode ? (operatingSystemConstants.signals[signalCode] ?? 0) : 0;
          const exitCode = code ?? (signalNumber ? 128 + signalNumber : 1);
          job.exitCode = exitCode;
          job.endedAt = Date.now();
          if (job.status === "running") job.status = "exited";

          if (!settled) {
            jobs.delete(identifier);
            const snapshot = readLogTail(logPath, DEFAULT_MAX_LINES);
            const details = snapshot.fullOutputPath ? { truncation: snapshot.truncation, fullOutputPath: snapshot.fullOutputPath } : undefined;
            if (!snapshot.fullOutputPath) {
              try {
                unlinkSync(logPath);
              } catch {}
            }
            if (job.status === "timed_out") {
              const message = snapshot.text ? `${snapshot.text}\n\nCommand timed out after ${parameters.timeout} seconds` : `Command timed out after ${parameters.timeout} seconds`;
              finishInline(message, details, true);
              return;
            }
            if (exitCode !== 0) {
              const message = snapshot.text ? `${snapshot.text}\n\nCommand exited with code ${exitCode}` : `Command exited with code ${exitCode}`;
              finishInline(message, details, true);
              return;
            }
            finishInline(snapshot.text || "(no output)", details, false);
            return;
          }

          renderStatus();
          if (shuttingDown || job.silent) return;

          const snapshot = readLogTail(logPath, DEFAULT_MAX_LINES);
          const durationSeconds = Math.round((job.endedAt - job.startedAt) / 100) / 10;
          pi.sendMessage<CompletionDetails>(
            {
              customType: EXTENSION_KEY,
              content: formatJobReport(job, snapshot),
              display: true,
              details: {
                job: job.identifier,
                command: job.command,
                status: job.status,
                exitCode,
                durationSeconds,
                logPath,
                output: snapshot.text,
              },
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        });
      });
    },
  });

  pi.registerTool({
    name: "bash_output",
    label: "bash_output",
    description: "Inspect status and recent output of background bash jobs. Omit job to list all jobs.",
    promptSnippet: "Inspect status and output of background bash jobs",
    parameters: Type.Object({
      job: Type.Optional(Type.String({ description: "Job identifier (for example job-1). Omit to list all jobs." })),
    }),

    async execute(_toolCallIdentifier, parameters, _signal, _onUpdate, context) {
      activeContext = context;
      if (!parameters.job) {
        const listed = [...jobs.values()].filter((job) => job.backgrounded);
        if (listed.length === 0) return { content: [{ type: "text", text: "No background jobs." }], details: {} };
        const text = listed.map(formatJobSummary).join("\n");
        return { content: [{ type: "text", text }], details: {} };
      }

      const job = jobs.get(parameters.job);
      if (!job) return { content: [{ type: "text", text: `Unknown job: ${parameters.job}` }], details: {}, isError: true };
      const snapshot = readLogTail(job.logPath, DEFAULT_MAX_LINES);
      return { content: [{ type: "text", text: formatJobReport(job, snapshot) }], details: { fullOutputPath: job.logPath } };
    },
  });

  pi.registerTool({
    name: "bash_kill",
    label: "bash_kill",
    description: "Stop a running background bash job and its child processes.",
    promptSnippet: "Stop a running background bash job",
    parameters: Type.Object({
      job: Type.String({ description: "Job identifier to stop (for example job-1)" }),
    }),

    async execute(_toolCallIdentifier, parameters, _signal, _onUpdate, context) {
      activeContext = context;
      const job = jobs.get(parameters.job);
      if (!job) return { content: [{ type: "text", text: `Unknown job: ${parameters.job}` }], details: {}, isError: true };
      if (job.status !== "running") return { content: [{ type: "text", text: `${job.identifier} is already ${job.status}.` }], details: {} };

      stopJob(job, true);
      const snapshot = readLogTail(job.logPath, PARTIAL_PREVIEW_LINES);
      return { content: [{ type: "text", text: formatJobReport(job, snapshot) }], details: { fullOutputPath: job.logPath } };
    },
  });

  pi.registerCommand("jobs", {
    description: "List, inspect, or kill background bash jobs (/jobs [kill <id>])",
    handler: async (argumentsText, context) => {
      activeContext = context;
      const trimmed = argumentsText.trim();
      if (trimmed.startsWith("kill ")) {
        const identifier = trimmed.slice(5).trim();
        const job = jobs.get(identifier);
        if (!job) {
          context.ui.notify(`Unknown job: ${identifier}`, "error");
          return;
        }
        stopJob(job, false);
        context.ui.notify(`Killed ${identifier}`, "info");
        return;
      }

      const listed = [...jobs.values()].filter((job) => job.backgrounded);
      if (listed.length === 0) {
        context.ui.notify("No background jobs", "info");
        return;
      }

      const choice = await context.ui.select("Background jobs", listed.map(formatJobSummary));
      if (!choice) return;
      const identifier = choice.split(/\s+/)[0];
      const job = jobs.get(identifier);
      if (!job) return;

      if (job.status === "running") {
        const action = await context.ui.select(identifier, ["Show recent output", "Kill job"]);
        if (action === "Kill job") {
          stopJob(job, false);
          context.ui.notify(`Killed ${identifier}`, "info");
          return;
        }
        if (!action) return;
      }

      const snapshot = readLogTail(job.logPath, PARTIAL_PREVIEW_LINES);
      context.ui.notify(formatJobReport(job, snapshot), "info");
    },
  });
}

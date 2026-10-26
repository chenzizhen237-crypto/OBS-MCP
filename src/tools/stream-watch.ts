/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OBSWebSocketClient } from "../client.js";
import { READ_ONLY_TOOL } from "./request-tool.js";
import { activeStreamWatch, describeStream, StreamMonitor, type StreamSummary } from "./stream-monitor.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** JSON has no -Infinity; silence reports as null. */
export function jsonSummary(summary: StreamSummary): Record<string, unknown> {
  return {
    ...summary,
    audio: {
      ...summary.audio,
      levels: summary.audio.levels.map((level) => ({ ...level, peakDb: Number.isFinite(level.peakDb) ? level.peakDb : null })),
    },
  };
}

/** The watch that finished last, so obs-stream-watch-stop can be repeated. */
const finishedWatches = new WeakMap<OBSWebSocketClient, StreamSummary>();
const starting = new WeakSet<OBSWebSocketClient>();

function noWatch(): CallToolResult {
  return errorResult("No stream watch is running; start one with obs-stream-watch-start");
}

export function initialize(server: McpServer, client: OBSWebSocketClient): void {
  server.registerTool(
    "obs-stream-watch-start",
    {
      title: "Watch Stream Health",
      description: "Start watching the stream's health until obs-stream-watch-stop: bitrate against the target, "
        + "frames dropped on the network, congestion, reconnects, stalled output, render and encoder lag, dead "
        + "air and clipping on the streamed audio track, and a black program output. Works before going live "
        + "and across stream restarts. Never starts or stops the stream. Read the result with obs-stream-watch-status",
      inputSchema: z.object({
        targetKbps: z.number().int().positive().optional()
          .describe("Expected total bitrate in kbps; read from the profile in Simple output mode when left out"),
        deadAirSeconds: z.number().int().min(2).max(600).default(10)
          .describe("Seconds of silence on the streamed track before dead air is reported"),
        silenceThresholdDb: z.number().max(0).default(-50).describe("Streamed audio below this level counts as silence"),
        pictureChecks: z.boolean().default(true).describe("Sample the program output for a black picture"),
      }),
      annotations: READ_ONLY_TOOL,
    },
    async (args) => {
      const running = activeStreamWatch(client);
      if (running) {
        return {
          content: [{ type: "text", text: `Already watching the stream (${running.now()}s)\n${describeStream(running.summary()).join("\n")}` }],
          structuredContent: jsonSummary(running.summary()),
        };
      }
      if (starting.has(client)) return errorResult("A stream watch is being started; check it with obs-stream-watch-status");
      starting.add(client);
      try {
        await client.connect();
        const monitor = new StreamMonitor(client, args);
        await monitor.start();
        finishedWatches.delete(client);
        const summary = monitor.summary();
        return {
          content: [{
            type: "text",
            text: `Watching the stream${summary.live ? " (live)" : " (not live yet; checks begin when it goes live)"}. `
              + `Bitrate target: ${summary.bitrate.targetKbps === null ? "unknown, so low bitrate is not reported" : `${summary.bitrate.targetKbps} kbps`}. `
              + `Picture checks ${summary.pictureChecks}. Read it with obs-stream-watch-status; stop with obs-stream-watch-stop`,
          }],
          structuredContent: jsonSummary(summary),
        };
      } catch (error) {
        await activeStreamWatch(client)?.stop();
        return errorResult(`Watch Stream Health failed: ${errorMessage(error)}`);
      } finally {
        starting.delete(client);
      }
    },
  );

  server.registerTool(
    "obs-stream-watch-status",
    {
      title: "Stream Health",
      description: "Report the watched stream's health (good, degraded, bad, or offline) with the reasons, bitrate, "
        + "dropped frames, congestion, reconnects, render and encoder lag, streamed audio levels, dead air, black "
        + "picture, and warnings so far",
      inputSchema: z.object({}),
      annotations: READ_ONLY_TOOL,
    },
    async () => {
      const monitor = activeStreamWatch(client);
      if (!monitor) return noWatch();
      const summary = monitor.summary();
      return {
        content: [{ type: "text", text: describeStream(summary).join("\n") }],
        structuredContent: jsonSummary(summary),
      };
    },
  );

  server.registerTool(
    "obs-stream-watch-stop",
    {
      title: "Stop Watching Stream",
      description: "Stop watching the stream and report what the watch saw. The stream itself keeps running; "
        + "use obs-stop-stream to end it",
      inputSchema: z.object({}),
      annotations: READ_ONLY_TOOL,
    },
    async () => {
      const monitor = activeStreamWatch(client);
      const summary = monitor ? await monitor.stop() : finishedWatches.get(client);
      if (!summary) return noWatch();
      finishedWatches.set(client, summary);
      return {
        content: [{ type: "text", text: [`Stopped watching after ${summary.durationSeconds}s`, ...describeStream(summary)].join("\n") }],
        structuredContent: jsonSummary(summary),
      };
    },
  );
}

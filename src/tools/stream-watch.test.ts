/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeObsState } from "../../test/support/fake-obs-state.js";
import { advanceStream, healthyStreamObsState, healthyStreamState, serveStreamState, type FakeStreamState } from "../../test/support/fake-obs-stream.js";
import { resultText, startMcpHarness, type McpHarness } from "../../test/support/mcp-harness.js";
import { activeStreamWatch } from "./stream-monitor.js";
import { parseToolFilter } from "./toolsets.js";

let harness: McpHarness;
let directory: string;
let state: FakeObsState;
let stream: FakeStreamState;

async function startHarness(env: NodeJS.ProcessEnv = {}): Promise<void> {
  harness = await startMcpHarness({ supportedImageFormats: ["png", "ppm"], filter: parseToolFilter(env) });
  serveStreamState(harness.fakeObs, () => state, () => stream, (live) => advanceStream(live, { seconds: 0.5 }));
}

async function readHealth(): Promise<Record<string, unknown>> {
  const { contents } = await harness.mcpClient.readResource({ uri: "obs://stream/health" });
  return JSON.parse((contents[0] as { text: string }).text) as Record<string, unknown>;
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  directory = mkdtempSync(join(tmpdir(), "obs-mcp-stream-watch-"));
  state = healthyStreamObsState(directory);
  stream = healthyStreamState();
  await startHarness();
});

afterEach(async () => {
  await activeStreamWatch(harness.obsClient)?.stop();
  await harness.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("stream watch tools", () => {
  it("refuses status and stop before a watch starts", async () => {
    for (const name of ["obs-stream-watch-status", "obs-stream-watch-stop"]) {
      const result = await harness.call(name);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("obs-stream-watch-start");
    }
    expect(await readHealth()).toEqual({ watching: false });
  });

  it("starts before going live, reports status, and stops without touching the stream", async () => {
    const started = await harness.call("obs-stream-watch-start", { pictureChecks: false });
    expect(started.isError).toBeFalsy();
    expect(resultText(started)).toContain("not live yet");
    expect(resultText(started)).toContain("4660 kbps");
    expect(started.structuredContent).toMatchObject({ watching: true, live: false, health: "offline" });

    stream.active = true;
    harness.fakeObs.sendEvent("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" });
    await vi.waitFor(async () => expect((await harness.call("obs-stream-watch-status")).structuredContent).toMatchObject({ live: true }));

    const status = await harness.call("obs-stream-watch-status");
    expect(resultText(status)).toMatch(/^Health: (good|degraded)/);
    expect(await readHealth()).toMatchObject({ watching: true, live: true });

    const stopped = await harness.call("obs-stream-watch-stop");
    expect(resultText(stopped)).toMatch(/^Stopped watching after/);
    expect(stopped.structuredContent).toMatchObject({ watching: false });
    expect(stream.active).toBe(true);
    const sent = harness.fakeObs.history().map(({ frame }) => String(frame.d.requestType ?? ""));
    expect(sent.filter((type) => /^(Start|Stop|Toggle)/.test(type))).toEqual([]);

    // Repeating stop returns the finished watch.
    expect((await harness.call("obs-stream-watch-stop")).structuredContent).toMatchObject({ watching: false });
    expect(await readHealth()).toEqual({ watching: false });
  });

  it("returns the running watch when started twice", async () => {
    await harness.call("obs-stream-watch-start", { pictureChecks: false });
    const again = await harness.call("obs-stream-watch-start", { pictureChecks: false });
    expect(again.isError).toBeFalsy();
    expect(resultText(again)).toMatch(/^Already watching the stream/);
  });

  it("reports JSON-safe audio levels", async () => {
    stream.active = true;
    await harness.call("obs-stream-watch-start", { pictureChecks: false });
    harness.fakeObs.sendEvent("InputVolumeMeters", { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, 0, 0]] }] });
    await vi.waitFor(async () => {
      const { audio } = (await harness.call("obs-stream-watch-status")).structuredContent as { audio: { levels: { peakDb: unknown }[] } };
      expect(audio.levels).toEqual([expect.objectContaining({ peakDb: null })]);
    });
  });

  it("sends a resource update when the watch raises a warning", async () => {
    const updated: string[] = [];
    harness.mcpClient.setNotificationHandler("notifications/resources/updated", (notification) => {
      updated.push(notification.params.uri);
    });
    await harness.mcpClient.subscribeResource({ uri: "obs://stream/health" });
    await harness.call("obs-stream-watch-start", { pictureChecks: false });

    await vi.waitFor(() => expect(updated).toContain("obs://stream/health"));
  });

  it("is available in read-only mode and in the stream group", async () => {
    await harness.close();
    await startHarness({ OBS_MCP_READ_ONLY: "true" });
    const readOnly = (await harness.mcpClient.listTools()).tools.map(({ name }) => name);
    expect(readOnly).toEqual(expect.arrayContaining(["obs-stream-preflight", "obs-stream-watch-start", "obs-stream-watch-status", "obs-stream-watch-stop"]));
    expect(readOnly).not.toContain("obs-start-stream");

    await harness.close();
    await startHarness({ OBS_MCP_TOOLSETS: "stream" });
    const streamGroup = (await harness.mcpClient.listTools()).tools.map(({ name }) => name);
    expect(streamGroup).toEqual(expect.arrayContaining(["obs-stream-preflight", "obs-stream-watch-start", "obs-start-stream"]));
  });
});

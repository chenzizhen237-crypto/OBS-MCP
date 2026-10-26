/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeOBSRequestError } from "../../test/support/fake-obs-server.js";
import type { FakeObsState } from "../../test/support/fake-obs-state.js";
import {
  healthyStreamObsState,
  healthyStreamState,
  serveStreamState,
  STREAM_KEY,
  type FakeStreamState,
} from "../../test/support/fake-obs-stream.js";
import { resultText, startMcpHarness, type McpHarness } from "../../test/support/mcp-harness.js";
import type { PreflightCheck } from "./preflight.js";
import { describeServer } from "./stream-preflight.js";

let harness: McpHarness;
let recordDirectory: string;
let state: FakeObsState;
let stream: FakeStreamState;

async function preflight(args: Record<string, unknown> = {}) {
  const result = await harness.call("obs-stream-preflight", args);
  expect(result.isError).toBeFalsy();
  const { ready, checks } = result.structuredContent as { ready: boolean; checks: PreflightCheck[] };
  const byId = (id: string) => checks.find((check) => check.id === id);
  return { result, ready, checks, byId };
}

async function startHarness(platform = "macos"): Promise<void> {
  harness = await startMcpHarness({ obsStudioVersion: "32.2.2", platform });
  serveStreamState(harness.fakeObs, () => state, () => stream);
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  recordDirectory = mkdtempSync(join(tmpdir(), "obs-mcp-stream-preflight-"));
  state = healthyStreamObsState(recordDirectory);
  stream = healthyStreamState();
  await startHarness();
});

afterEach(async () => {
  await harness.close();
  rmSync(recordDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("obs-stream-preflight", () => {
  it("reports ready with no failures or warnings for a healthy setup, without revealing the key", async () => {
    const { ready, checks, result } = await preflight();

    expect(ready).toBe(true);
    expect(checks.filter(({ status }) => status === "fail" || status === "warn")).toEqual([]);
    expect(checks.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "connection", "stream-idle", "stream-service", "stream-encoder", "bitrate", "performance", "stream-audio", "scene-items",
    ]));
    expect(resultText(result)).toMatch(/^Ready to go live/);
    expect(JSON.stringify(result)).not.toContain(STREAM_KEY);
  });

  it("is read-only", async () => {
    await preflight();
    const sent = harness.fakeObs.history().map(({ frame }) => frame.d.requestType).filter(Boolean);
    expect(sent.filter((type) => !/^(Get|Identify)/.test(String(type)))).toEqual([]);
  });

  it("fails when the stream is already live or reconnecting", async () => {
    stream.active = true;
    expect((await preflight()).byId("stream-idle")).toMatchObject({ status: "fail", message: "The stream is already live" });
    stream.reconnecting = true;
    const { ready, byId } = await preflight();
    expect(ready).toBe(false);
    expect(byId("stream-idle")?.message).toContain("reconnecting");
  });

  it("fails without a stream key or ingest server for a listed service", async () => {
    stream.serviceSettings = { service: "Twitch", server: "auto", key: "" };
    expect((await preflight()).byId("stream-service")).toMatchObject({ status: "fail", message: "No stream key is set for Twitch" });
    stream.serviceSettings = { service: "YouTube - RTMPS", server: "", key: STREAM_KEY };
    expect((await preflight()).byId("stream-service")?.status).toBe("fail");
    stream.serviceSettings = { server: "auto", key: STREAM_KEY };
    expect((await preflight()).byId("stream-service")?.message).toBe("No streaming service is selected");
  });

  it("checks custom servers and never shows the path or query that can carry the key", async () => {
    stream.serviceType = "rtmp_custom";
    stream.serviceSettings = { server: `srt://ingest.example.com:9000?streamid=${STREAM_KEY}`, key: "" };
    const { byId, result } = await preflight();
    expect(byId("stream-service")).toMatchObject({ status: "pass", message: "Streaming to srt://ingest.example.com:9000" });
    expect(JSON.stringify(result)).not.toContain(STREAM_KEY);

    stream.serviceSettings = { server: "rtmp://live.example.com/app", key: "" };
    expect((await preflight()).byId("stream-service")?.status).toBe("warn");

    stream.serviceSettings = { server: "live.example.com/app", key: STREAM_KEY };
    expect((await preflight()).byId("stream-service")?.status).toBe("fail");

    stream.serviceType = "whip_custom";
    stream.serviceSettings = { server: "https://whip.example.com/endpoint/abc", bearer_token: STREAM_KEY };
    expect((await preflight()).byId("stream-service")).toMatchObject({ status: "pass", message: "Streaming over WHIP to https://whip.example.com" });
  });

  it("redacts server URLs to scheme and host", () => {
    expect(describeServer("rtmps://a.rtmps.youtube.com:443/live2/key-here")).toBe("rtmps://a.rtmps.youtube.com:443");
    expect(describeServer("not a url")).toBe("a custom server");
  });

  it("fails an encoder that does not exist on the platform OBS runs on", async () => {
    state.profile["SimpleOutput/StreamEncoder"] = "jim_nvenc";
    expect((await preflight()).byId("stream-encoder")).toMatchObject({ status: "fail", message: expect.stringContaining("not available on macOS") });

    await harness.close();
    await startHarness("windows");
    expect((await preflight()).byId("stream-encoder")?.status).toBe("pass");
    state.profile["SimpleOutput/StreamEncoder"] = "apple_h264";
    expect((await preflight()).byId("stream-encoder")?.message).toContain("only available on macOS");
  });

  it("reads the Advanced-mode stream encoder and audio track", async () => {
    state.profile["Output/Mode"] = "Advanced";
    state.profile["AdvOut/Encoder"] = "obs_x264";
    state.profile["AdvOut/TrackIndex"] = "2";
    const { byId } = await preflight();

    expect(byId("stream-encoder")?.message).toBe("Advanced output mode streams with obs_x264");
    expect(byId("bitrate")?.status).toBe("unknown");
    // The mic feeds only track 1, so track 2 is silent.
    expect(byId("stream-audio")).toMatchObject({ status: "warn", message: expect.stringContaining("track 2") });
  });

  it("warns when the bitrate exceeds the service limit or is too low for the picture", async () => {
    expect((await preflight({ maxBitrateKbps: 4000 })).byId("bitrate")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("above the 4000 kbps limit"),
    });
    stream.video = { outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 };
    state.profile["SimpleOutput/VBitrate"] = "2500";
    expect((await preflight()).byId("bitrate")).toMatchObject({ status: "warn", message: expect.stringContaining("blocky") });
    state.profile["SimpleOutput/VBitrate"] = "6000";
    expect((await preflight()).byId("bitrate")?.status).toBe("pass");
  });

  it("warns when OBS falls behind its frame rate, misses frames, or uses most of the CPU", async () => {
    stream.stats = { ...stream.stats, activeFps: 24, renderSkippedFrames: 50, cpuUsage: 95 };
    const message = (await preflight()).byId("performance")?.message ?? "";
    expect(message).toContain("renders 24.0 of 30 fps");
    expect(message).toContain("5.0% of frames missed rendering");
    expect(message).toContain("95% CPU");
  });

  it("warns that the stream will be silent when no unmuted input feeds the streamed track", async () => {
    state.inputs = state.inputs.map((input) => (input.inputName === "Mic" ? { ...input, muted: true } : input));
    expect((await preflight()).byId("stream-audio")?.status).toBe("warn");

    state.inputs = state.inputs.map((input) => (input.inputName === "Mic" ? { ...input, muted: false } : input));
    stream.volumes.Mic = 0;
    expect((await preflight()).byId("stream-audio")?.status).toBe("warn");

    stream.volumes.Mic = 0.5;
    expect((await preflight()).byId("stream-audio")).toMatchObject({ status: "pass", message: "Track 1 carries: Mic" });
  });

  it("reports unknown instead of a result when OBS cannot answer a check", async () => {
    harness.fakeObs.respondWith("GetStreamServiceSettings", () => { throw new FakeOBSRequestError(600, "Service unavailable"); });
    const { byId, ready } = await preflight();
    expect(byId("stream-service")).toMatchObject({ status: "unknown", message: expect.stringContaining("Service unavailable") });
    expect(ready).toBe(true);
  });
});

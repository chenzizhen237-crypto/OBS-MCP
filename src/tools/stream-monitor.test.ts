/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventSubscription, OBSWebSocketClient } from "../client.js";
import { FakeOBSServer } from "../../test/support/fake-obs-server.js";
import type { FakeObsState } from "../../test/support/fake-obs-state.js";
import { advanceStream, healthyStreamObsState, healthyStreamState, serveStreamState, type FakeStreamState } from "../../test/support/fake-obs-stream.js";
import { encodePpm } from "./frame-sample.js";
import { activeStreamWatch, describeStream, StreamMonitor, type StreamMonitorOptions } from "./stream-monitor.js";

const POLL_MS = 20;

let fakeObs: FakeOBSServer;
let client: OBSWebSocketClient;
let state: FakeObsState;
let stream: FakeStreamState;
let directory: string;
/** What each poll adds to the live stream; null sends nothing (a stall). */
let perPoll: { kbps?: number; dropped?: number } | null;
let picture: () => Buffer;
let monitor: StreamMonitor | undefined;

const page = () => encodePpm(32, 18, (pixel) => (pixel % 3 ? [230, 230, 230] : [30, 30, 30]));
const black = () => encodePpm(32, 18, () => [0, 0, 0]);

async function startMonitor(options: StreamMonitorOptions = {}): Promise<StreamMonitor> {
  monitor = new StreamMonitor(client, {
    statsIntervalMs: POLL_MS,
    sampleIntervalMs: POLL_MS,
    deadAirSeconds: 60,
    healthWindowSeconds: 30,
    ...options,
  });
  await monitor.start();
  return monitor;
}

function meters(inputs: { inputName: string; peak: number }[]): void {
  fakeObs.sendEvent("InputVolumeMeters", {
    inputs: inputs.map(({ inputName, peak }) => ({ inputName, inputLevelsMul: [[peak / 2, peak, peak], [0, 0, 0]] })),
  });
}

function goLive(): void {
  stream.active = true;
  fakeObs.sendEvent("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" });
}

const warningKinds = (take: StreamMonitor) => take.summary().warnings.map(({ kind }) => kind);

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  directory = mkdtempSync(join(tmpdir(), "obs-mcp-stream-"));
  state = healthyStreamObsState(directory);
  state.inputs.push({ inputName: "Music", inputKind: "ffmpeg_source", muted: false, tracks: { 1: false, 2: true } });
  stream = healthyStreamState();
  perPoll = { kbps: 4_660 };
  picture = page;
  fakeObs = await FakeOBSServer.start({ supportedImageFormats: ["png", "ppm"] });
  // Each poll adds about POLL_MS of data: enough for a positive bitrate without depending on timing.
  serveStreamState(fakeObs, () => state, () => stream, (live) => {
    if (perPoll) advanceStream(live, { seconds: POLL_MS / 1000, ...perPoll });
  });
  fakeObs.respondWith("GetSourceScreenshot", ({ imageFormat }) => {
    expect(imageFormat).toBe("ppm");
    return { imageData: `data:image/ppm;base64,${picture().toString("base64")}` };
  });
  client = new OBSWebSocketClient(fakeObs.url);
  await client.connect();
});

afterEach(async () => {
  await monitor?.stop();
  monitor = undefined;
  await client.disconnect();
  await fakeObs.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("StreamMonitor", () => {
  it("subscribes to volume meters only while it runs, and is the active watch", async () => {
    const watch = await startMonitor();

    await vi.waitFor(() => expect(fakeObs.eventSubscriptions()).toBe(EventSubscription.All | EventSubscription.InputVolumeMeters));
    expect(activeStreamWatch(client)).toBe(watch);

    await watch.stop();
    await vi.waitFor(() => expect(fakeObs.eventSubscriptions()).toBe(EventSubscription.All));
    expect(activeStreamWatch(client)).toBeUndefined();
    expect(watch.summary().watching).toBe(false);
  });

  it("reports offline before the stream goes live, then a good stream with its bitrate", async () => {
    const watch = await startMonitor();
    expect(watch.summary()).toMatchObject({ live: false, health: "offline" });
    expect(watch.summary().bitrate.targetKbps).toBe(4_660);

    goLive();
    meters([{ inputName: "Mic", peak: 0.3 }]);
    await vi.waitFor(() => expect(watch.summary().bitrate.currentKbps).toBeGreaterThan(0));
    meters([{ inputName: "Mic", peak: 0.3 }]);

    const summary = watch.summary();
    expect(summary).toMatchObject({ live: true, health: "good", reasons: [] });
    expect(summary.network.droppedFrames).toBe(0);
    expect(summary.audio.levels[0]).toMatchObject({ inputName: "Mic", streamed: true, clips: 0 });
    expect(summary.events.map(({ type }) => type)).toContain("stream-start");
  });

  it("notices a stream that was already live when the watch started", async () => {
    stream.active = true;
    const watch = await startMonitor();
    expect(watch.summary().live).toBe(true);
    expect(watch.summary().events.map(({ type }) => type)).toContain("stream-live");
  });

  it("warns about frames dropped on the network and rates heavy drops as bad", async () => {
    stream.active = true;
    const watch = await startMonitor();
    perPoll = { kbps: 4_660, dropped: 2 };

    await vi.waitFor(() => expect(warningKinds(watch)).toContain("network"));
    await vi.waitFor(() => expect(watch.summary().health).toBe("bad"));
    expect(watch.summary().reasons.join()).toContain("dropped on the network");
    expect(watch.summary().network.droppedFrames).toBeGreaterThan(0);
    // Repeats are rate-limited.
    expect(watch.summary().warnings.filter(({ kind }) => kind === "network")).toHaveLength(1);
  });

  it("reports sustained congestion", async () => {
    stream.active = true;
    stream.congestion = 0.8;
    const watch = await startMonitor();

    await vi.waitFor(() => expect(warningKinds(watch)).toContain("network"));
    expect(watch.summary()).toMatchObject({ health: "degraded", network: { congestion: 0.8, peakCongestion: 0.8 } });
  });

  it("reports a stalled output as bad", async () => {
    stream.active = true;
    const watch = await startMonitor();
    await vi.waitFor(() => expect(watch.summary().bitrate.currentKbps).toBeGreaterThan(0));
    perPoll = null;

    await vi.waitFor(() => expect(watch.summary().network.stalls).toBe(1));
    expect(watch.summary().health).toBe("bad");
    expect(watch.summary().warnings.find(({ kind }) => kind === "output")?.message).toContain("sent no data");
  });

  it("reports a bitrate far under the target", async () => {
    stream.active = true;
    const watch = await startMonitor({ targetKbps: 1_000_000_000 });

    await vi.waitFor(() => expect(warningKinds(watch)).toContain("bitrate"));
    expect(watch.summary().health).toBe("bad");
  });

  it("does not judge bitrate without a target", async () => {
    state.profile["Output/Mode"] = "Advanced";
    stream.active = true;
    const watch = await startMonitor();
    await vi.waitFor(() => expect(watch.summary().bitrate.currentKbps).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5));

    expect(watch.summary().bitrate.targetKbps).toBeNull();
    expect(warningKinds(watch)).not.toContain("bitrate");
  });

  it("tracks reconnects: bad while reconnecting, degraded just after", async () => {
    stream.active = true;
    const watch = await startMonitor();
    fakeObs.sendEvent("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_RECONNECTING" });
    stream.reconnecting = true;
    await vi.waitFor(() => expect(watch.summary().reconnecting).toBe(true));
    expect(watch.summary()).toMatchObject({ health: "bad", network: { reconnects: 1 } });

    stream.reconnecting = false;
    fakeObs.sendEvent("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_RECONNECTED" });
    await vi.waitFor(() => expect(watch.summary().reconnecting).toBe(false));
    expect(watch.summary().health).toBe("degraded");
    expect(watch.summary().reasons).toContain("The stream reconnected recently");
    expect(watch.summary().network.reconnects).toBe(1);
  });

  it("warns when the stream goes offline while watched, and keeps watching for a restart", async () => {
    stream.active = true;
    const watch = await startMonitor();
    await vi.waitFor(() => expect(watch.summary().bitrate.currentKbps).toBeGreaterThan(0));

    stream.active = false;
    fakeObs.sendEvent("StreamStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" });
    await vi.waitFor(() => expect(watch.summary().health).toBe("offline"));
    expect(watch.summary().warnings.filter(({ kind }) => kind === "output")).toHaveLength(1);

    // A restarted stream counts its bytes from zero.
    stream.bytes = 0;
    stream.total = 0;
    goLive();
    await vi.waitFor(() => expect(watch.summary().live).toBe(true));
    expect(watch.summary().watching).toBe(true);
  });

  it("reports dead air on the streamed track, ignoring inputs on other tracks", async () => {
    stream.active = true;
    const watch = await startMonitor({ deadAirSeconds: 0.2 });
    const music = setInterval(() => meters([{ inputName: "Music", peak: 0.8 }, { inputName: "Mic", peak: 0 }]), 10);
    try {
      await vi.waitFor(() => expect(watch.summary().audio.deadAir).toHaveLength(1));
      expect(watch.summary().warnings.find(({ kind }) => kind === "audio")?.message).toContain("track 1");
      expect(watch.summary().health).toBe("degraded");
    } finally {
      clearInterval(music);
    }

    meters([{ inputName: "Mic", peak: 0.3 }]);
    await vi.waitFor(() => expect(watch.summary().events.map(({ type }) => type)).toContain("audio-back"));
    const summary = await watch.stop();
    expect(summary.audio.deadAir).toHaveLength(1);
    expect(summary.audio.levels.find(({ inputName }) => inputName === "Music")).toMatchObject({ streamed: false });
  });

  it("follows audio track changes made while watching", async () => {
    stream.active = true;
    const watch = await startMonitor({ deadAirSeconds: 60 });
    fakeObs.sendEvent("InputAudioTracksChanged", { inputName: "Music", inputAudioTracks: { 1: true, 2: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    meters([{ inputName: "Music", peak: 0.5 }]);
    await vi.waitFor(() => expect(watch.summary().audio.levels.find(({ inputName }) => inputName === "Music")?.streamed).toBe(true));
  });

  it("warns once about a clipping input until the repeat interval passes", async () => {
    stream.active = true;
    const watch = await startMonitor();
    meters([{ inputName: "Mic", peak: 1 }]);
    meters([{ inputName: "Mic", peak: 1 }]);
    await vi.waitFor(() => expect(watch.summary().audio.levels[0]?.clips).toBe(2));

    const clipping = watch.summary().warnings.filter(({ message }) => message.includes("clipping"));
    expect(clipping).toHaveLength(1);
    expect(clipping[0]?.message).toContain("Mic is clipping at 0 dB");
  });

  it("reports a black program output while live as bad", async () => {
    stream.active = true;
    picture = black;
    const watch = await startMonitor();

    await vi.waitFor(() => expect(warningKinds(watch)).toContain("blank"));
    expect(watch.summary().health).toBe("bad");
    picture = page;
    await vi.waitFor(() => expect(watch.summary().blanks).toHaveLength(1));
    expect(watch.summary().blanks[0]!.endSeconds).toBeGreaterThan(watch.summary().blanks[0]!.startSeconds);
  });

  it("skips picture checks when asked to or when OBS cannot return PPM", async () => {
    stream.active = true;
    const watch = await startMonitor({ pictureChecks: false });
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
    expect(watch.summary().pictureChecks).toBe("off");
    expect(fakeObs.history().some(({ frame }) => frame.d.requestType === "GetSourceScreenshot")).toBe(false);
  });

  it("warns about render and encoder lag while live", async () => {
    stream.active = true;
    const watch = await startMonitor();
    stream.stats = { ...stream.stats, renderSkippedFrames: 40, renderTotalFrames: 1_060, outputSkippedFrames: 3, outputTotalFrames: 1_060 };

    await vi.waitFor(() => expect(watch.summary().performance.renderSkipped).toBe(40));
    expect(watch.summary().warnings.filter(({ kind }) => kind === "frames").map(({ message }) => message)).toEqual([
      expect.stringContaining("missed 40 frame(s) while rendering"),
      expect.stringContaining("skipped 3 frame(s)"),
    ]);
    await vi.waitFor(() => expect(watch.summary().reasons.join()).toContain("missed rendering"));
  });

  it("describes a summary in a few lines", async () => {
    stream.active = true;
    const watch = await startMonitor();
    await vi.waitFor(() => expect(watch.summary().bitrate.currentKbps).toBeGreaterThan(0));
    const lines = describeStream(watch.summary());
    expect(lines[0]).toBe("Health: good");
    expect(lines.join("\n")).toMatch(/Bitrate: \d+ kbps now/);
  });
});

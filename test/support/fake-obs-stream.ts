/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { FakeOBSRequestError, type FakeOBSServer } from "./fake-obs-server.js";
import { healthyObsState, servePreflightState, type FakeObsState } from "./fake-obs-state.js";

export const STREAM_KEY = "live_123456_secretStreamKey";

/** The stream side of a fake OBS; tests change it between polls. */
export type FakeStreamState = {
  active: boolean;
  reconnecting: boolean;
  /** Cumulative, as GetStreamStatus reports them. */
  bytes: number;
  dropped: number;
  total: number;
  congestion: number;
  serviceType: string;
  serviceSettings: Record<string, unknown>;
  stats: {
    cpuUsage: number;
    activeFps: number;
    renderSkippedFrames: number;
    renderTotalFrames: number;
    outputSkippedFrames: number;
    outputTotalFrames: number;
  };
  video: { outputWidth: number; outputHeight: number; fpsNumerator: number; fpsDenominator: number };
  /** inputVolumeMul per input; inputs left out are at full volume. */
  volumes: Record<string, number>;
};

/** A setup obs-stream-preflight passes: Twitch with a key, 4500 + 160 kbps at 720p30, an unmuted mic on track 1. */
export function healthyStreamObsState(recordDirectory: string): FakeObsState {
  const state = healthyObsState(recordDirectory);
  state.profile = {
    ...state.profile,
    "SimpleOutput/StreamEncoder": "apple_h264",
    "SimpleOutput/VBitrate": "4500",
    "SimpleOutput/ABitrate": "160",
  };
  state.inputs = [
    ...state.inputs,
    { inputName: "Mic", inputKind: "coreaudio_input_capture", muted: false, tracks: { 1: true, 2: false } },
  ];
  return state;
}

export function healthyStreamState(): FakeStreamState {
  return {
    active: false,
    reconnecting: false,
    bytes: 0,
    dropped: 0,
    total: 0,
    congestion: 0,
    serviceType: "rtmp_common",
    serviceSettings: { service: "Twitch", server: "auto", key: STREAM_KEY },
    stats: { cpuUsage: 12, activeFps: 30, renderSkippedFrames: 0, renderTotalFrames: 1_000, outputSkippedFrames: 0, outputTotalFrames: 1_000 },
    video: { outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1 },
    volumes: {},
  };
}

/** Answers the requests obs-stream-preflight and the stream monitor make. */
export function serveStreamState(
  fakeObs: FakeOBSServer,
  getState: () => FakeObsState,
  getStream: () => FakeStreamState,
  /** Runs before each GetStreamStatus answer, e.g. to send more data while live. */
  beforePoll?: (stream: FakeStreamState) => void,
): void {
  servePreflightState(fakeObs, getState);
  fakeObs.respondWith("GetStats", () => ({ ...getStream().stats, availableDiskSpace: getState().availableDiskSpace }));
  fakeObs.respondWith("GetStreamStatus", () => {
    const stream = getStream();
    if (stream.active) beforePoll?.(stream);
    return {
      outputActive: stream.active,
      outputReconnecting: stream.reconnecting,
      outputBytes: stream.bytes,
      outputSkippedFrames: stream.dropped,
      outputTotalFrames: stream.total,
      outputCongestion: stream.congestion,
      outputTimecode: "00:00:00.000",
      outputDuration: 0,
    };
  });
  fakeObs.respondWith("GetStreamServiceSettings", () => ({
    streamServiceType: getStream().serviceType,
    streamServiceSettings: getStream().serviceSettings,
  }));
  fakeObs.respondWith("GetVideoSettings", () => ({ baseWidth: 1920, baseHeight: 1080, ...getStream().video }));
  fakeObs.respondWith("GetInputVolume", ({ inputName }) => {
    const input = getState().inputs.find((candidate) => candidate.inputName === inputName);
    if (!input) throw new FakeOBSRequestError(600, "No source was found");
    if (input.muted === undefined) throw new FakeOBSRequestError(604, "The specified input does not support audio");
    const inputVolumeMul = getStream().volumes[String(inputName)] ?? 1;
    return { inputVolumeMul, inputVolumeDb: inputVolumeMul > 0 ? 20 * Math.log10(inputVolumeMul) : -100 };
  });
}

/** Advances a live fake stream as if `seconds` passed at `kbps` with `dropped` of the new frames lost. */
export function advanceStream(stream: FakeStreamState, { seconds = 1, kbps = 4_660, frames = 30, dropped = 0 } = {}): void {
  stream.bytes += Math.round((kbps * 1000 * seconds) / 8);
  stream.total += Math.round(frames * seconds);
  stream.dropped += dropped;
}

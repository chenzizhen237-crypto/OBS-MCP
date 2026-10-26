/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { EventEmitter } from "node:events";
import { EventSubscription, type OBSWebSocketClient } from "../client.js";
import { logger } from "../logger.js";
import { decodePpm, isBlank } from "./frame-sample.js";
import { streamedTrack, streamTargetKbps } from "./stream-preflight.js";

type JsonObject = Record<string, unknown>;

export type StreamWarningKind = "network" | "bitrate" | "output" | "frames" | "audio" | "blank" | "connection";
export type StreamWarning = { atSeconds: number; kind: StreamWarningKind; message: string };
export type StreamEvent = { atSeconds: number; type: string; detail?: string };
export type StreamSpan = { startSeconds: number; endSeconds: number };
export type StreamHealth = "good" | "degraded" | "bad" | "offline";

export type StreamInputLevel = {
  inputName: string;
  /** Loudest level after volume and mute, in dBFS. */
  peakDb: number;
  /** Whether the input feeds the track the stream carries. */
  streamed: boolean;
  /** Meter readings at or above the clipping level. */
  clips: number;
};

export type StreamSummary = {
  watching: boolean;
  startedAt: string;
  /** Seconds since the watch started. */
  durationSeconds: number;
  /** Seconds the stream was live while watched. */
  liveSeconds: number;
  live: boolean;
  reconnecting: boolean;
  health: StreamHealth;
  /** Why health is not good, from the last healthWindowSeconds. */
  reasons: string[];
  bitrate: { currentKbps: number | null; averageKbps: number | null; minKbps: number | null; maxKbps: number | null; targetKbps: number | null };
  network: { droppedFrames: number; totalFrames: number; droppedPercent: number; congestion: number | null; peakCongestion: number; reconnects: number; stalls: number };
  performance: { renderSkipped: number; renderTotal: number; encoderSkipped: number; encoderTotal: number; cpuUsage: number | null; activeFps: number | null };
  audio: { checks: "on" | "off"; streamedTrack: number; levels: StreamInputLevel[]; deadAir: StreamSpan[] };
  blanks: StreamSpan[];
  framesSampled: number;
  pictureChecks: "on" | "off";
  warnings: StreamWarning[];
  events: StreamEvent[];
};

export type StreamMonitorOptions = {
  statsIntervalMs?: number;
  sampleIntervalMs?: number;
  pictureChecks?: boolean;
  /** Streamed audio below this level counts as silence. */
  silenceThresholdDb?: number;
  /** Seconds of streamed silence before dead air is reported. */
  deadAirSeconds?: number;
  /** Peaks at or above this level count as clipping. */
  clipDb?: number;
  /** Expected total bitrate; read from a Simple-mode profile when left out. */
  targetKbps?: number;
  /** Bitrate below this share of the target is reported. */
  lowBitrateRatio?: number;
  /** How far back health looks. */
  healthWindowSeconds?: number;
};

type Sample = {
  atSeconds: number;
  kbps: number;
  congestion: number | null;
  dropped: number;
  total: number;
  renderSkipped: number;
  renderTotal: number;
  encoderSkipped: number;
  encoderTotal: number;
};

const SAMPLE_WIDTH = 96;
const MAX_EVENTS = 500;
const MAX_WARNINGS_PER_KIND = 20;
const BLANK_SAMPLES_TO_WARN = 2;
/** Samples in a row before a stall, low bitrate, or congestion is reported, so one slow poll is not. */
const STALL_SAMPLES = 2;
const LOW_BITRATE_SAMPLES = 3;
const CONGESTED_SAMPLES = 2;
const CONGESTED = 0.5;
/** Dropped or skipped shares of frames in the health window. */
const DEGRADED_SHARE = 0.01;
const BAD_SHARE = 0.05;
const REPEAT_WARNING_MS = 10_000;

const LOGGED_EVENTS: Record<string, (data: JsonObject) => string | undefined> = {
  CurrentProgramSceneChanged: (data) => String(data.sceneName ?? ""),
  InputMuteStateChanged: (data) => `${String(data.inputName)} ${data.inputMuted ? "muted" : "unmuted"}`,
  InputAudioTracksChanged: (data) => String(data.inputName ?? ""),
  StreamServiceSettingsChanged: () => undefined,
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDb(multiplier: number): number {
  return multiplier > 0 ? Math.round(20 * Math.log10(multiplier) * 10) / 10 : -Infinity;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** Tells the obs://stream/health resource that the watch changed. */
export const streamUpdates = new EventEmitter().setMaxListeners(0);
const activeWatches = new WeakMap<OBSWebSocketClient, StreamMonitor>();

export function activeStreamWatch(client: OBSWebSocketClient): StreamMonitor | undefined {
  return activeWatches.get(client);
}

/**
 * Watches a live stream: bitrate, network drops, congestion, reconnects and
 * stalls from GetStreamStatus; render and encoder lag from GetStats; dead
 * air and clipping on the streamed track from InputVolumeMeters; and a 96px
 * sample of the program output for black picture. It can be started before
 * going live and keeps watching across stream restarts until stopped.
 */
export class StreamMonitor {
  private readonly client: OBSWebSocketClient;
  private readonly options: Required<Omit<StreamMonitorOptions, "targetKbps">>;
  private targetKbps: number | null;
  private startedAtMs = 0;
  private stoppedAtMs: number | null = null;
  private live = false;
  private reconnecting = false;
  private liveMs = 0;
  private liveSinceMs: number | null = null;
  private readonly warnings: StreamWarning[] = [];
  private readonly events: StreamEvent[] = [];
  private readonly samples: Sample[] = [];
  private previous: { atMs: number; bytes: number; dropped: number; total: number } | null = null;
  private previousStats: JsonObject | null = null;
  private pendingPerf = { renderSkipped: 0, renderTotal: 0, encoderSkipped: 0, encoderTotal: 0 };
  private readonly totals = { dropped: 0, total: 0, renderSkipped: 0, renderTotal: 0, encoderSkipped: 0, encoderTotal: 0 };
  private readonly kbps = { current: null as number | null, sum: 0, count: 0, min: Infinity, max: -Infinity };
  private congestion: number | null = null;
  private peakCongestion = 0;
  private reconnects = 0;
  private stalls = 0;
  private stallRun = 0;
  private lowRun = 0;
  private congestedRun = 0;
  private cpuUsage: number | null = null;
  private activeFps: number | null = null;
  private track = 1;
  private readonly inputTracks = new Map<string, JsonObject>();
  private readonly levels = new Map<string, StreamInputLevel>();
  private metersSeen = false;
  private lastAudibleMs = 0;
  private deadAirSince: number | null = null;
  private readonly deadAir: StreamSpan[] = [];
  private readonly blanks: StreamSpan[] = [];
  private blankRun = 0;
  private blankSince: number | null = null;
  private framesSampled = 0;
  private pictureChecks: "on" | "off" = "off";
  private programScene: string | null = null;
  private readonly lastWarningMs = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly busy = new Set<string>();
  private releaseMeters: (() => void) | null = null;
  private readonly listeners: [string, (...args: unknown[]) => void][] = [];
  private stopPromise: Promise<StreamSummary> | undefined;

  constructor(client: OBSWebSocketClient, options: StreamMonitorOptions = {}) {
    this.client = client;
    this.options = {
      statsIntervalMs: options.statsIntervalMs ?? 2_000,
      sampleIntervalMs: options.sampleIntervalMs ?? 2_000,
      pictureChecks: options.pictureChecks ?? true,
      silenceThresholdDb: options.silenceThresholdDb ?? -50,
      deadAirSeconds: options.deadAirSeconds ?? 10,
      clipDb: options.clipDb ?? -0.5,
      lowBitrateRatio: options.lowBitrateRatio ?? 0.5,
      healthWindowSeconds: options.healthWindowSeconds ?? 30,
    };
    this.targetKbps = options.targetKbps ?? null;
  }

  /** Seconds since the watch started. */
  now(): number {
    return round(((this.stoppedAtMs ?? Date.now()) - this.startedAtMs) / 1000);
  }

  isRunning(): boolean {
    return this.stoppedAtMs === null;
  }

  async start(): Promise<void> {
    this.startedAtMs = Date.now();
    this.lastAudibleMs = this.startedAtMs;
    activeWatches.set(this.client, this);

    this.listen("StreamStateChanged", (data) => this.onStreamState(data));
    this.listen("InputVolumeMeters", (data) => this.onMeters(data));
    this.listen("InputAudioTracksChanged", (data) => {
      if (typeof data.inputName === "string" && isObject(data.inputAudioTracks)) this.inputTracks.set(data.inputName, data.inputAudioTracks);
    });
    this.listen("CurrentProgramSceneChanged", (data) => {
      if (typeof data.sceneName === "string") this.programScene = data.sceneName;
    });
    for (const [event, describe] of Object.entries(LOGGED_EVENTS)) {
      this.listen(event, (data) => this.log(event, describe(data)));
    }
    const onDisconnect = () => this.warn("connection", "Lost the connection to OBS; checks paused until it reconnects");
    this.client.on("disconnected", onDisconnect);
    this.listeners.push(["disconnected", onDisconnect]);

    await Promise.all([
      this.loadTracks(),
      this.loadProgramScene(),
      this.loadTarget(),
      this.sampleStatus().catch(() => undefined),
      this.sampleStats().catch(() => undefined),
    ]);
    if (this.stoppedAtMs !== null) return;
    this.releaseMeters = this.client.subscribeHighVolume(EventSubscription.InputVolumeMeters);

    const formats = this.client.getConnectionStatus().versionInfo?.supportedImageFormats;
    this.pictureChecks = this.options.pictureChecks && Array.isArray(formats) && formats.includes("ppm") ? "on" : "off";
    if (this.pictureChecks === "on") this.every(this.options.sampleIntervalMs, "picture", () => this.samplePicture());
    this.every(this.options.statsIntervalMs, "status", async () => {
      await this.sampleStatus();
      this.checkDeadAir();
    });
    this.every(this.options.statsIntervalMs, "stats", () => this.sampleStats());
    this.changed();
  }

  stop(): Promise<StreamSummary> {
    return this.stopPromise ??= this.finishStop();
  }

  private async finishStop(): Promise<StreamSummary> {
    if (this.stoppedAtMs === null) {
      this.stoppedAtMs = Date.now();
      for (const timer of this.timers) clearInterval(timer);
      this.timers.length = 0;
      this.releaseMeters?.();
      this.releaseMeters = null;
      for (const [event, listener] of this.listeners) this.client.off(event, listener);
      this.listeners.length = 0;
      this.setLive(false);
      const end = this.now();
      this.closeDeadAir(end);
      this.closeBlank(end);
      if (activeWatches.get(this.client) === this) activeWatches.delete(this.client);
      this.changed();
    }
    return this.summary();
  }

  summary(): StreamSummary {
    const { health, reasons } = this.health();
    const liveMs = this.liveMs + (this.liveSinceMs === null ? 0 : (this.stoppedAtMs ?? Date.now()) - this.liveSinceMs);
    return {
      watching: this.stoppedAtMs === null,
      startedAt: new Date(this.startedAtMs).toISOString(),
      durationSeconds: this.now(),
      liveSeconds: round(liveMs / 1000),
      live: this.live,
      reconnecting: this.reconnecting,
      health,
      reasons,
      bitrate: {
        currentKbps: this.kbps.current,
        averageKbps: this.kbps.count > 0 ? Math.round(this.kbps.sum / this.kbps.count) : null,
        minKbps: this.kbps.count > 0 ? this.kbps.min : null,
        maxKbps: this.kbps.count > 0 ? this.kbps.max : null,
        targetKbps: this.targetKbps,
      },
      network: {
        droppedFrames: this.totals.dropped,
        totalFrames: this.totals.total,
        droppedPercent: round(share(this.totals.dropped, this.totals.total) * 100),
        congestion: this.congestion,
        peakCongestion: round(this.peakCongestion),
        reconnects: this.reconnects,
        stalls: this.stalls,
      },
      performance: {
        renderSkipped: this.totals.renderSkipped,
        renderTotal: this.totals.renderTotal,
        encoderSkipped: this.totals.encoderSkipped,
        encoderTotal: this.totals.encoderTotal,
        cpuUsage: this.cpuUsage,
        activeFps: this.activeFps,
      },
      audio: {
        checks: this.metersSeen ? "on" : "off",
        streamedTrack: this.track,
        levels: [...this.levels.values()].sort((a, b) => b.peakDb - a.peakDb),
        deadAir: [...this.deadAir, ...this.openSpan(this.deadAirSince)],
      },
      blanks: [...this.blanks, ...this.openSpan(this.blankSince)],
      framesSampled: this.framesSampled,
      pictureChecks: this.pictureChecks,
      warnings: [...this.warnings],
      events: [...this.events],
    };
  }

  /** Rates the last healthWindowSeconds: bad when viewers are losing the stream, degraded when they would notice. */
  health(): { health: StreamHealth; reasons: string[] } {
    if (!this.live) return { health: "offline", reasons: ["The stream is not live"] };
    const bad: string[] = [];
    const degraded: string[] = [];
    const since = this.now() - this.options.healthWindowSeconds;
    const recent = this.samples.filter(({ atSeconds }) => atSeconds >= since);
    const sum = (field: keyof Sample) => recent.reduce((total, sample) => total + (Number(sample[field]) || 0), 0);

    if (this.reconnecting) bad.push("The stream is reconnecting");
    if (this.stallRun >= STALL_SAMPLES) bad.push("OBS has stopped sending data");
    if (this.blankRun >= BLANK_SAMPLES_TO_WARN) bad.push("The program output is black");
    const dropped = share(sum("dropped"), sum("total"));
    if (dropped >= BAD_SHARE) bad.push(`${(dropped * 100).toFixed(1)}% of frames dropped on the network`);
    else if (dropped >= DEGRADED_SHARE) degraded.push(`${(dropped * 100).toFixed(1)}% of frames dropped on the network`);
    if (this.targetKbps && this.kbps.current !== null && this.lowRun >= LOW_BITRATE_SAMPLES) {
      (this.kbps.current < this.targetKbps * this.options.lowBitrateRatio / 2 ? bad : degraded)
        .push(`Sending ${this.kbps.current} of ${this.targetKbps} kbps`);
    }
    if (this.congestedRun >= CONGESTED_SAMPLES) degraded.push(`Network congestion at ${Math.round((this.congestion ?? 0) * 100)}%`);
    const render = share(sum("renderSkipped"), sum("renderTotal"));
    const encoder = share(sum("encoderSkipped"), sum("encoderTotal"));
    if (render >= DEGRADED_SHARE) degraded.push(`${(render * 100).toFixed(1)}% of frames missed rendering`);
    if (encoder >= DEGRADED_SHARE) degraded.push(`${(encoder * 100).toFixed(1)}% of frames skipped encoding`);
    if (this.deadAirSince !== null) degraded.push(`No streamed audio since ${this.deadAirSince}s`);
    if (this.events.some(({ type, atSeconds }) => type === "reconnecting" && atSeconds >= since) && !this.reconnecting) {
      degraded.push("The stream reconnected recently");
    }

    if (bad.length > 0) return { health: "bad", reasons: [...bad, ...degraded] };
    if (degraded.length > 0) return { health: "degraded", reasons: degraded };
    return { health: "good", reasons: [] };
  }

  private openSpan(since: number | null): StreamSpan[] {
    return since === null || this.stoppedAtMs !== null ? [] : [{ startSeconds: since, endSeconds: this.now() }];
  }

  private listen(event: string, handler: (data: JsonObject) => void): void {
    const listener = (data: unknown) => handler(isObject(data) ? data : {});
    this.client.on(event, listener);
    this.listeners.push([event, listener as (...args: unknown[]) => void]);
  }

  private every(intervalMs: number, name: string, task: () => Promise<void>): void {
    const timer = setInterval(() => {
      if (this.busy.has(name)) return;
      this.busy.add(name);
      task().catch((error: unknown) => {
        logger.debug(`Stream monitor ${name} check failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => this.busy.delete(name));
    }, intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  private changed(): void {
    streamUpdates.emit("update");
  }

  private log(type: string, detail?: string): void {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push({ atSeconds: this.now(), type, ...(detail ? { detail } : {}) });
  }

  private warn(kind: StreamWarningKind, message: string): void {
    if (this.warnings.filter((warning) => warning.kind === kind).length >= MAX_WARNINGS_PER_KIND) return;
    this.warnings.push({ atSeconds: this.now(), kind, message });
    this.changed();
  }

  /** Warns at most once per REPEAT_WARNING_MS for the same key. */
  private warnEvery(key: string, kind: StreamWarningKind, message: string): void {
    const nowMs = Date.now();
    if (nowMs - (this.lastWarningMs.get(key) ?? -Infinity) < REPEAT_WARNING_MS) return;
    this.lastWarningMs.set(key, nowMs);
    this.warn(kind, message);
  }

  private setLive(live: boolean): void {
    if (live === this.live) return;
    this.live = live;
    const nowMs = this.stoppedAtMs ?? Date.now();
    if (live) {
      this.liveSinceMs = nowMs;
      this.lastAudibleMs = nowMs;
    } else {
      if (this.liveSinceMs !== null) this.liveMs += nowMs - this.liveSinceMs;
      this.liveSinceMs = null;
      this.reconnecting = false;
      this.previous = null;
      this.stallRun = 0;
      this.lowRun = 0;
      this.congestedRun = 0;
      this.blankRun = 0;
      const at = this.now();
      this.closeDeadAir(at);
      this.closeBlank(at);
    }
    this.changed();
  }

  private onStreamState(data: JsonObject): void {
    switch (data.outputState) {
      case "OBS_WEBSOCKET_OUTPUT_STARTED":
        this.log("stream-start");
        this.setLive(true);
        break;
      case "OBS_WEBSOCKET_OUTPUT_RECONNECTING":
        if (!this.reconnecting) {
          this.reconnecting = true;
          this.reconnects += 1;
          this.log("reconnecting");
          this.warn("connection", "The stream lost its connection to the server and is reconnecting");
        }
        break;
      case "OBS_WEBSOCKET_OUTPUT_RECONNECTED":
        this.reconnecting = false;
        this.previous = null;
        this.log("reconnected");
        this.changed();
        break;
      case "OBS_WEBSOCKET_OUTPUT_STOPPED":
        if (this.live) this.warn("output", "The stream went offline while being watched");
        this.log("stream-stop");
        this.setLive(false);
        break;
      default:
        break;
    }
  }

  private async loadTracks(): Promise<void> {
    try {
      this.track = await streamedTrack(this.client);
      const { inputs } = await this.client.sendRequest("GetInputList") as { inputs?: unknown[] };
      const names = (inputs ?? []).filter(isObject).map(({ inputName }) => inputName).filter((name): name is string => typeof name === "string");
      const results = await this.client.sendBatch(names.map((inputName) => ({ requestType: "GetInputAudioTracks", requestData: { inputName } })));
      names.forEach((name, index) => {
        const result = results[index];
        if (result?.ok && isObject(result.responseData) && isObject(result.responseData.inputAudioTracks)) {
          this.inputTracks.set(name, result.responseData.inputAudioTracks);
        }
      });
    } catch (error) {
      // Unknown routing counts as streamed, which errs toward hearing audio, not reporting dead air.
      this.log("tracks-unknown", error instanceof Error ? error.message : String(error));
    }
  }

  private async loadProgramScene(): Promise<void> {
    const program = await this.client.sendRequest("GetCurrentProgramScene").catch(() => ({})) as JsonObject;
    const name = program.currentProgramSceneName ?? program.sceneName;
    this.programScene = typeof name === "string" ? name : null;
  }

  private async loadTarget(): Promise<void> {
    if (this.targetKbps !== null) return;
    const target = await streamTargetKbps(this.client).catch(() => null);
    this.targetKbps = target ? target.videoKbps + target.audioKbps : null;
  }

  private isStreamed(inputName: string): boolean {
    const tracks = this.inputTracks.get(inputName);
    return !tracks || tracks[String(this.track)] === true;
  }

  private async sampleStatus(): Promise<void> {
    const status = await this.client.sendRequest("GetStreamStatus") as JsonObject;
    if (this.stoppedAtMs !== null) return;
    if (status.outputActive !== true) {
      if (this.live) {
        this.warn("output", "The stream went offline while being watched");
        this.log("stream-stop");
      }
      this.setLive(false);
      return;
    }
    if (!this.live) {
      this.log("stream-live");
      this.setLive(true);
    }
    if (status.outputReconnecting === true && !this.reconnecting) {
      this.onStreamState({ outputState: "OBS_WEBSOCKET_OUTPUT_RECONNECTING" });
    } else if (status.outputReconnecting === false && this.reconnecting) {
      this.onStreamState({ outputState: "OBS_WEBSOCKET_OUTPUT_RECONNECTED" });
    }

    if (typeof status.outputCongestion === "number") {
      this.congestion = round(status.outputCongestion);
      this.peakCongestion = Math.max(this.peakCongestion, status.outputCongestion);
    }
    const nowMs = Date.now();
    const current = {
      atMs: nowMs,
      bytes: Number(status.outputBytes ?? 0),
      dropped: Number(status.outputSkippedFrames ?? 0),
      total: Number(status.outputTotalFrames ?? 0),
    };
    const previous = this.previous;
    this.previous = current;
    // A restarted stream counts from zero again.
    if (!previous || this.reconnecting || current.bytes < previous.bytes || current.total < previous.total) return;

    const seconds = (current.atMs - previous.atMs) / 1000;
    if (seconds <= 0) return;
    const bytes = current.bytes - previous.bytes;
    const kbps = Math.round((bytes * 8) / 1000 / seconds);
    const dropped = Math.max(0, current.dropped - previous.dropped);
    const total = Math.max(0, current.total - previous.total);
    this.kbps.current = kbps;
    this.kbps.sum += kbps;
    this.kbps.count += 1;
    this.kbps.min = Math.min(this.kbps.min, kbps);
    this.kbps.max = Math.max(this.kbps.max, kbps);
    this.totals.dropped += dropped;
    this.totals.total += total;
    this.samples.push({ atSeconds: this.now(), kbps, congestion: this.congestion, dropped, total, ...this.pendingPerf });
    this.pendingPerf = { renderSkipped: 0, renderTotal: 0, encoderSkipped: 0, encoderTotal: 0 };
    const keepSince = this.now() - this.options.healthWindowSeconds;
    while (this.samples.length > 0 && this.samples[0]!.atSeconds < keepSince) this.samples.shift();

    this.stallRun = bytes === 0 ? this.stallRun + 1 : 0;
    if (this.stallRun === STALL_SAMPLES) {
      this.stalls += 1;
      this.warn("output", `OBS has sent no data for ${Math.round(seconds * STALL_SAMPLES)}s while live; the encoder or connection is stuck`);
    }

    this.lowRun = this.targetKbps && kbps < this.targetKbps * this.options.lowBitrateRatio ? this.lowRun + 1 : 0;
    if (this.lowRun === LOW_BITRATE_SAMPLES) {
      this.warn("bitrate", `Sending ${kbps} kbps, under ${Math.round(this.options.lowBitrateRatio * 100)}% of the `
        + `${this.targetKbps} kbps target; the upload is struggling or dynamic bitrate has backed off`);
    }

    this.congestedRun = (this.congestion ?? 0) >= CONGESTED ? this.congestedRun + 1 : 0;
    if (this.congestedRun === CONGESTED_SAMPLES) {
      this.warn("network", `Network congestion at ${Math.round((this.congestion ?? 0) * 100)}%; frames will drop if it continues`);
    }

    const recentDropped = this.samples.reduce((sum, sample) => sum + sample.dropped, 0);
    const recentTotal = this.samples.reduce((sum, sample) => sum + sample.total, 0);
    if (dropped > 0 && share(recentDropped, recentTotal) >= DEGRADED_SHARE) {
      this.warnEvery("dropped", "network", `${dropped} frame(s) dropped on the network `
        + `(${(share(recentDropped, recentTotal) * 100).toFixed(1)}% recently); lower the bitrate or check the upload`);
    }
  }

  private async sampleStats(): Promise<void> {
    const stats = await this.client.sendRequest("GetStats") as JsonObject;
    if (typeof stats.cpuUsage === "number") this.cpuUsage = round(stats.cpuUsage);
    if (typeof stats.activeFps === "number") this.activeFps = round(stats.activeFps);
    const previous = this.previousStats;
    this.previousStats = stats;
    if (!previous || !this.live) return;

    const delta = (field: string) => Math.max(0, Number(stats[field] ?? 0) - Number(previous[field] ?? 0));
    const perf = {
      renderSkipped: delta("renderSkippedFrames"),
      renderTotal: delta("renderTotalFrames"),
      encoderSkipped: delta("outputSkippedFrames"),
      encoderTotal: delta("outputTotalFrames"),
    };
    for (const key of Object.keys(perf) as (keyof typeof perf)[]) {
      this.totals[key] += perf[key];
      this.pendingPerf[key] += perf[key];
    }
    if (perf.renderSkipped > 0) {
      this.warnEvery("render", "frames", `OBS missed ${perf.renderSkipped} frame(s) while rendering; the GPU is overloaded`);
    }
    if (perf.encoderSkipped > 0) {
      this.warnEvery("encoder", "frames", `The encoder skipped ${perf.encoderSkipped} frame(s); use a faster preset or a hardware encoder`);
    }
  }

  private onMeters(data: JsonObject): void {
    if (this.stoppedAtMs !== null || !Array.isArray(data.inputs)) return;
    this.metersSeen = true;
    if (!this.live || this.reconnecting) return;
    const nowMs = Date.now();
    let heard = false;
    for (const input of data.inputs) {
      if (!isObject(input) || typeof input.inputName !== "string" || !Array.isArray(input.inputLevelsMul)) continue;
      // Each channel is [magnitude, peak, input peak]; peak is after volume and mute.
      let peak = 0;
      for (const channel of input.inputLevelsMul) {
        if (Array.isArray(channel)) peak = Math.max(peak, Number(channel[1]) || 0);
      }
      const name = input.inputName;
      const streamed = this.isStreamed(name);
      const peakDb = toDb(peak);
      const level = this.levels.get(name);
      const clipping = streamed && peakDb >= this.options.clipDb;
      this.levels.set(name, {
        inputName: name,
        peakDb: Math.max(level?.peakDb ?? -Infinity, peakDb),
        streamed,
        clips: (level?.clips ?? 0) + (clipping ? 1 : 0),
      });
      if (clipping) this.warnEvery(`clip:${name}`, "audio", `${name} is clipping at ${peakDb} dB; lower its gain or add a limiter`);
      if (streamed && peakDb > this.options.silenceThresholdDb) heard = true;
    }
    if (heard) {
      this.lastAudibleMs = nowMs;
      if (this.deadAirSince !== null) {
        this.log("audio-back");
        this.closeDeadAir(this.now());
      }
    }
  }

  private checkDeadAir(): void {
    if (!this.metersSeen || !this.live || this.reconnecting || this.deadAirSince !== null) return;
    const silentMs = Date.now() - this.lastAudibleMs;
    if (silentMs < this.options.deadAirSeconds * 1000) return;
    this.deadAirSince = round(Math.max(0, this.lastAudibleMs - this.startedAtMs) / 1000);
    this.log("dead-air");
    this.warn("audio", `No streamed audio above ${this.options.silenceThresholdDb} dB for ${Math.round(silentMs / 1000)}s; `
      + `check the microphone and that inputs feed track ${this.track}`);
  }

  private async samplePicture(): Promise<void> {
    if (!this.programScene || !this.live) return;
    const response = await this.client.sendRequest("GetSourceScreenshot", {
      sourceName: this.programScene,
      imageFormat: "ppm",
      imageWidth: SAMPLE_WIDTH,
    }) as JsonObject;
    if (typeof response.imageData !== "string" || this.stoppedAtMs !== null || !this.live) return;
    const sample = decodePpm(response.imageData);
    const at = this.now();
    this.framesSampled += 1;
    if (isBlank(sample)) {
      this.blankRun += 1;
      if (this.blankRun === BLANK_SAMPLES_TO_WARN) {
        this.blankSince = round(at - this.options.sampleIntervalMs / 1000);
        this.warn("blank", `Viewers see a black screen: the program output (${this.programScene}) is black`);
      }
    } else {
      this.blankRun = 0;
      this.closeBlank(at);
    }
  }

  private closeDeadAir(at: number): void {
    if (this.deadAirSince !== null) this.deadAir.push({ startSeconds: this.deadAirSince, endSeconds: at });
    this.deadAirSince = null;
  }

  private closeBlank(at: number): void {
    if (this.blankSince !== null) this.blanks.push({ startSeconds: this.blankSince, endSeconds: at });
    this.blankSince = null;
  }
}

/** Short report lines for tool results. */
export function describeStream(summary: StreamSummary): string[] {
  const lines = [
    `Health: ${summary.health}${summary.reasons.length > 0 && summary.health !== "offline" ? ` (${summary.reasons.join("; ")})` : ""}`,
    summary.live
      ? `Live for ${summary.liveSeconds}s of ${summary.durationSeconds}s watched${summary.reconnecting ? ", reconnecting" : ""}`
      : `Not live; watched ${summary.durationSeconds}s, live for ${summary.liveSeconds}s`,
  ];
  const { bitrate, network, performance } = summary;
  if (bitrate.currentKbps !== null) {
    lines.push(`Bitrate: ${bitrate.currentKbps} kbps now, ${bitrate.averageKbps} average (${bitrate.minKbps}–${bitrate.maxKbps})`
      + (bitrate.targetKbps ? `, target ${bitrate.targetKbps}` : ""));
  }
  if (network.totalFrames > 0 || network.reconnects > 0) {
    lines.push(`Network: ${network.droppedFrames} of ${network.totalFrames} frames dropped (${network.droppedPercent}%), `
      + `congestion ${network.congestion === null ? "unknown" : `${Math.round(network.congestion * 100)}%`}, ${network.reconnects} reconnect(s)`);
  }
  if (performance.renderSkipped + performance.encoderSkipped > 0) {
    lines.push(`Performance: ${performance.renderSkipped} frame(s) missed rendering, ${performance.encoderSkipped} skipped encoding`);
  }
  const loudest = summary.audio.levels.find(({ streamed }) => streamed);
  if (summary.audio.checks === "on") {
    lines.push(loudest && Number.isFinite(loudest.peakDb)
      ? `Audio: loudest streamed input ${loudest.inputName} at ${loudest.peakDb} dB, ${summary.audio.deadAir.length} dead-air stretch(es)`
      : "Audio: nothing heard on the streamed track");
  }
  if (summary.blanks.length > 0) lines.push(`Picture: ${summary.blanks.length} black stretch(es)`);
  for (const warning of summary.warnings.slice(-10)) lines.push(`Warning at ${warning.atSeconds}s: ${warning.message}`);
  return lines;
}

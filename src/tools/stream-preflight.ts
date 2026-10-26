/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OBSWebSocketClient } from "../client.js";
import {
  checkSceneItems,
  MAC_ONLY_ENCODER,
  NON_MAC_ENCODER,
  profileParameter,
  runCheck,
  SETTINGS_DIALOG_NOTE,
  STATUS_MARK,
  type PreflightCheck,
} from "./preflight.js";
import { READ_ONLY_TOOL } from "./request-tool.js";

type JsonObject = Record<string, unknown>;

export type StreamPreflightOptions = {
  /** The most the service accepts, e.g. 6000 for Twitch; checked against the Simple-mode bitrate. */
  maxBitrateKbps?: number;
};

/** Below this many bits per pixel per frame, motion turns to blocks on most encoders. */
const MIN_BITS_PER_PIXEL = 0.03;
const MAX_CPU_PERCENT = 85;
/** Render or encoder lag above this share of frames shows as stutter on stream. */
const MAX_SKIPPED_SHARE = 0.01;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function request(client: OBSWebSocketClient, requestType: string, data?: JsonObject): Promise<JsonObject> {
  const response = await client.sendRequest(requestType, data);
  return isObject(response) ? response : {};
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Scheme and host only: custom servers often carry the stream key in the
 * path or query (SRT streamid, RTMP app/key), and the key must never be shown.
 */
export function describeServer(server: string): string {
  try {
    const url = new URL(server);
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
  } catch {
    return "a custom server";
  }
}

async function checkStreamIdle(client: OBSWebSocketClient): Promise<PreflightCheck> {
  const status = await request(client, "GetStreamStatus");
  if (typeof status.outputActive !== "boolean") return { id: "stream-idle", status: "unknown", message: "OBS did not report streaming state" };
  if (status.outputReconnecting === true) return { id: "stream-idle", status: "fail", message: "The stream is live and reconnecting" };
  return status.outputActive
    ? { id: "stream-idle", status: "fail", message: "The stream is already live" }
    : { id: "stream-idle", status: "pass", message: "Not streaming yet" };
}

async function checkStreamService(client: OBSWebSocketClient): Promise<PreflightCheck> {
  const response = await request(client, "GetStreamServiceSettings");
  const type = response.streamServiceType;
  const settings = isObject(response.streamServiceSettings) ? response.streamServiceSettings : {};
  if (!nonEmpty(type)) return { id: "stream-service", status: "unknown", message: "OBS did not report a stream service" };

  if (type === "rtmp_common") {
    const service = nonEmpty(settings.service) ? settings.service : "the selected service";
    if (!nonEmpty(settings.service)) return { id: "stream-service", status: "fail", message: "No streaming service is selected" };
    if (!nonEmpty(settings.server)) return { id: "stream-service", status: "fail", message: `No ingest server is selected for ${service}` };
    if (!nonEmpty(settings.key)) return { id: "stream-service", status: "fail", message: `No stream key is set for ${service}` };
    return { id: "stream-service", status: "pass", message: `Streaming to ${service} (${settings.server === "auto" ? "automatic server" : "fixed server"}), key set` };
  }
  if (type === "rtmp_custom") {
    if (!nonEmpty(settings.server)) return { id: "stream-service", status: "fail", message: "No custom server URL is set" };
    if (!/^(rtmps?|srt|rist):\/\//i.test(settings.server)) {
      return { id: "stream-service", status: "fail", message: `The custom server is not an rtmp://, rtmps://, srt:// or rist:// URL (${describeServer(settings.server)})` };
    }
    if (!nonEmpty(settings.key) && /^rtmps?:/i.test(settings.server)) {
      return { id: "stream-service", status: "warn", message: `Streaming to ${describeServer(settings.server)} with no stream key; most RTMP servers refuse that` };
    }
    return { id: "stream-service", status: "pass", message: `Streaming to ${describeServer(settings.server)}` };
  }
  if (type === "whip_custom") {
    if (!nonEmpty(settings.server)) return { id: "stream-service", status: "fail", message: "No WHIP endpoint URL is set" };
    if (!/^https?:\/\//i.test(settings.server)) return { id: "stream-service", status: "fail", message: "The WHIP endpoint is not an http(s):// URL" };
    return { id: "stream-service", status: "pass", message: `Streaming over WHIP to ${describeServer(settings.server)}` };
  }
  return { id: "stream-service", status: "unknown", message: `Stream service type ${type} is not checked` };
}

/** The encoder OBS's frontend uses for the stream in the current output mode. */
async function streamEncoder(client: OBSWebSocketClient): Promise<{ mode: string; encoder: string | null }> {
  const mode = await profileParameter(client, "Output", "Mode") ?? "Simple";
  const encoder = mode === "Advanced"
    ? await profileParameter(client, "AdvOut", "Encoder")
    : await profileParameter(client, "SimpleOutput", "StreamEncoder");
  return { mode, encoder };
}

async function checkStreamEncoder(client: OBSWebSocketClient): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const { mode, encoder } = await streamEncoder(client);
  const platform = client.getConnectionStatus().versionInfo?.platform;
  if (!encoder) {
    checks.push({ id: "stream-encoder", status: "unknown", message: `${mode} output mode has no stream encoder set` });
  } else if (platform === "macos" && NON_MAC_ENCODER.test(encoder)) {
    checks.push({ id: "stream-encoder", status: "fail", message: `Stream encoder ${encoder} is not available on macOS` });
  } else if (platform && platform !== "macos" && MAC_ONLY_ENCODER.test(encoder)) {
    checks.push({ id: "stream-encoder", status: "fail", message: `Stream encoder ${encoder} is only available on macOS` });
  } else {
    checks.push({ id: "stream-encoder", status: "pass", message: `${mode} output mode streams with ${encoder}` });
  }
  if (client.hasPendingOutputSettings()) {
    checks.push({
      id: "output-settings",
      status: "fail",
      message: "Output settings were changed through this server since OBS last started; "
        + "OBS will ignore them (or fail to start) until it rebuilds its outputs. Restart OBS first",
    });
  }
  return checks;
}

/**
 * The stream's video and audio bitrate in kbps. Simple mode keeps them in
 * the profile; Advanced mode keeps them in streamEncoder.json, which OBS
 * WebSocket cannot read, so they are unknown there.
 */
export async function streamTargetKbps(client: OBSWebSocketClient): Promise<{ videoKbps: number; audioKbps: number } | null> {
  const mode = await profileParameter(client, "Output", "Mode") ?? "Simple";
  if (mode === "Advanced") return null;
  const [video, audio] = await Promise.all([
    profileParameter(client, "SimpleOutput", "VBitrate"),
    profileParameter(client, "SimpleOutput", "ABitrate"),
  ]);
  const videoKbps = Number(video);
  if (!Number.isFinite(videoKbps) || videoKbps <= 0) return null;
  const audioKbps = Number(audio);
  return { videoKbps, audioKbps: Number.isFinite(audioKbps) && audioKbps > 0 ? audioKbps : 160 };
}

async function checkBitrate(client: OBSWebSocketClient, options: StreamPreflightOptions): Promise<PreflightCheck> {
  const [target, video] = await Promise.all([streamTargetKbps(client), request(client, "GetVideoSettings")]);
  if (!target) {
    return { id: "bitrate", status: "unknown", message: "Advanced output mode keeps the stream bitrate where OBS WebSocket cannot read it" };
  }
  const total = target.videoKbps + target.audioKbps;
  if (options.maxBitrateKbps !== undefined && total > options.maxBitrateKbps) {
    return {
      id: "bitrate",
      status: "warn",
      message: `Streaming at ${target.videoKbps} + ${target.audioKbps} kbps, above the ${options.maxBitrateKbps} kbps limit; `
        + "the service may refuse or cut the stream",
    };
  }
  const width = Number(video.outputWidth);
  const height = Number(video.outputHeight);
  const fps = Number(video.fpsNumerator) / Number(video.fpsDenominator);
  if ([width, height, fps].every((value) => Number.isFinite(value) && value > 0)) {
    const bitsPerPixel = (target.videoKbps * 1000) / (width * height * fps);
    if (bitsPerPixel < MIN_BITS_PER_PIXEL) {
      return {
        id: "bitrate",
        status: "warn",
        message: `${target.videoKbps} kbps is low for ${width}×${height} at ${Math.round(fps)} fps; `
          + "motion will look blocky. Lower the output resolution or frame rate, or raise the bitrate",
      };
    }
    return { id: "bitrate", status: "pass", message: `${target.videoKbps} + ${target.audioKbps} kbps for ${width}×${height} at ${Math.round(fps)} fps` };
  }
  return { id: "bitrate", status: "pass", message: `${target.videoKbps} + ${target.audioKbps} kbps` };
}

async function checkPerformance(client: OBSWebSocketClient): Promise<PreflightCheck> {
  const [stats, video] = await Promise.all([request(client, "GetStats"), request(client, "GetVideoSettings")]);
  const problems: string[] = [];
  const fps = Number(video.fpsNumerator) / Number(video.fpsDenominator);
  if (typeof stats.activeFps === "number" && Number.isFinite(fps) && fps > 0 && stats.activeFps < fps * 0.95) {
    problems.push(`OBS renders ${stats.activeFps.toFixed(1)} of ${Math.round(fps)} fps`);
  }
  const share = (skipped: unknown, total: unknown) => (
    typeof skipped === "number" && typeof total === "number" && total > 0 ? skipped / total : 0
  );
  const render = share(stats.renderSkippedFrames, stats.renderTotalFrames);
  const encoder = share(stats.outputSkippedFrames, stats.outputTotalFrames);
  if (render > MAX_SKIPPED_SHARE) problems.push(`${(render * 100).toFixed(1)}% of frames missed rendering since OBS started (GPU overloaded)`);
  if (encoder > MAX_SKIPPED_SHARE) problems.push(`${(encoder * 100).toFixed(1)}% of frames skipped encoding since OBS started (encoder overloaded)`);
  if (typeof stats.cpuUsage === "number" && stats.cpuUsage > MAX_CPU_PERCENT) problems.push(`OBS is using ${Math.round(stats.cpuUsage)}% CPU`);
  if (problems.length > 0) return { id: "performance", status: "warn", message: problems.join("; ") };
  if (typeof stats.activeFps !== "number") return { id: "performance", status: "unknown", message: "OBS did not report its frame rate" };
  return { id: "performance", status: "pass", message: `Rendering at ${stats.activeFps.toFixed(1)} fps` };
}

/**
 * The audio track the stream carries. Simple mode streams track 1; Advanced
 * mode streams AdvOut/TrackIndex.
 */
export async function streamedTrack(client: OBSWebSocketClient): Promise<number> {
  const mode = await profileParameter(client, "Output", "Mode") ?? "Simple";
  if (mode !== "Advanced") return 1;
  const track = Number(await profileParameter(client, "AdvOut", "TrackIndex"));
  return Number.isInteger(track) && track >= 1 && track <= 6 ? track : 1;
}

async function checkStreamAudio(client: OBSWebSocketClient): Promise<PreflightCheck> {
  const [{ inputs }, track] = await Promise.all([request(client, "GetInputList"), streamedTrack(client)]);
  if (!Array.isArray(inputs)) return { id: "stream-audio", status: "unknown", message: "OBS did not report its inputs" };
  const names = inputs.filter(isObject).map(({ inputName }) => inputName).filter(nonEmpty);
  // Video-only inputs fail these requests; the batch reports that without failing the rest.
  const results = await client.sendBatch(names.flatMap((inputName) => [
    { requestType: "GetInputMute", requestData: { inputName } },
    { requestType: "GetInputAudioTracks", requestData: { inputName } },
    { requestType: "GetInputVolume", requestData: { inputName } },
  ]));
  const heard: string[] = [];
  const unreadable: string[] = [];
  names.forEach((inputName, index) => {
    const [mute, tracks, volume] = [results[index * 3], results[index * 3 + 1], results[index * 3 + 2]];
    if (!mute?.ok) {
      if (mute?.code !== 604) unreadable.push(inputName);
      return;
    }
    if (!isObject(mute.responseData) || mute.responseData.inputMuted !== false) return;
    const routing = tracks?.ok && isObject(tracks.responseData) ? tracks.responseData.inputAudioTracks : undefined;
    if (!isObject(routing) || typeof routing[String(track)] !== "boolean") {
      unreadable.push(inputName);
      return;
    }
    if (routing[String(track)] !== true) return;
    const level = volume?.ok && isObject(volume.responseData) ? volume.responseData.inputVolumeMul : undefined;
    if (typeof level === "number" && level <= 0) return;
    heard.push(inputName);
  });
  if (heard.length > 0) return { id: "stream-audio", status: "pass", message: `Track ${track} carries: ${heard.join(", ")}` };
  if (unreadable.length > 0) return { id: "stream-audio", status: "unknown", message: `Could not read audio routing for: ${unreadable.join(", ")}` };
  return {
    id: "stream-audio",
    status: "warn",
    message: `No unmuted input feeds audio track ${track}, so the stream will be silent`,
  };
}

export async function runStreamPreflight(
  client: OBSWebSocketClient,
  options: StreamPreflightOptions = {},
): Promise<{ ready: boolean; checks: PreflightCheck[] }> {
  try {
    await client.connect();
  } catch (error) {
    return { ready: false, checks: [{ id: "connection", status: "fail", message: `Cannot reach OBS: ${errorMessage(error)}` }] };
  }
  const groups = await Promise.all([
    runCheck("stream-idle", () => checkStreamIdle(client)),
    runCheck("stream-service", () => checkStreamService(client)),
    runCheck("stream-encoder", () => checkStreamEncoder(client)),
    runCheck("bitrate", () => checkBitrate(client, options)),
    runCheck("performance", () => checkPerformance(client)),
    runCheck("stream-audio", () => checkStreamAudio(client)),
    runCheck("scene-items", () => checkSceneItems(client)),
  ]);
  const checks = [
    { id: "connection", status: "pass" as const, message: "Connected to OBS" },
    ...groups.flat(),
    SETTINGS_DIALOG_NOTE,
  ];
  return { ready: !checks.some(({ status }) => status === "fail"), checks };
}

export function initialize(server: McpServer, client: OBSWebSocketClient): void {
  server.registerTool(
    "obs-stream-preflight",
    {
      title: "Stream Preflight",
      description: "Check whether OBS is ready to go live without changing anything: the stream is not already "
        + "live, a service, server, and key are set (the key is never returned), the stream encoder exists on "
        + "this platform, output settings are applied, the bitrate suits the resolution and service, OBS keeps "
        + "up with its frame rate, the stream carries audio, and the program scene has sized sources. Run it "
        + "before obs-start-stream",
      inputSchema: z.object({
        maxBitrateKbps: z.number().int().positive().optional()
          .describe("The service's bitrate limit in kbps (video plus audio), e.g. 6000 for Twitch"),
      }),
      annotations: READ_ONLY_TOOL,
    },
    async ({ maxBitrateKbps }): Promise<CallToolResult> => {
      const result = await runStreamPreflight(client, { maxBitrateKbps });
      const lines = result.checks.map(({ status, id, message }) => `${STATUS_MARK[status]} ${id}: ${message}`);
      return {
        content: [{ type: "text", text: `${result.ready ? "Ready to go live" : "Not ready to go live"}\n${lines.join("\n")}` }],
        structuredContent: result,
      };
    },
  );
}

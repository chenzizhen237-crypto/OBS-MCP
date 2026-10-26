/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OBSWebSocketClient } from "../client.js";
import { logger } from "../logger.js";
import {
  canvasSize,
  checkLocalFile,
  clearSlotTimer,
  ensureOverlays,
  ensureScene,
  errorMessage,
  errorResult,
  hideSlot,
  INTRO_PREFIX,
  OVERLAY_SCENE,
  placeSlot,
  slotInput,
  tryRequest,
} from "./graphics.js";
import { fillTransform, loadTheme, POSITIONS, positionTransform, type Position } from "./graphics-theme.js";
import { NON_IDEMPOTENT_WRITE_TOOL } from "./request-tool.js";

type JsonObject = Record<string, unknown>;

const MEDIA_KIND = "ffmpeg_source";
const RESTART = "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Media source settings for a local file that plays from the start whenever it is shown. */
function mediaSettings(file: string, loop: boolean): JsonObject {
  return { is_local_file: true, local_file: file, looping: loop, restart_on_activate: true, close_when_inactive: true };
}

/**
 * Calls onEnd once when OBS reports that inputName finished playing.
 * Returns a function that stops waiting.
 */
function onPlaybackEnded(client: OBSWebSocketClient, inputName: string, onEnd: () => void): () => void {
  const listener = (data: unknown) => {
    if (!isObject(data) || data.inputName !== inputName) return;
    stop();
    onEnd();
  };
  const stop = () => client.off("MediaInputPlaybackEnded", listener);
  client.on("MediaInputPlaybackEnded", listener);
  return stop;
}

/** One pending end-of-playback action per input, so playing again replaces the earlier one. */
const pending = new WeakMap<OBSWebSocketClient, Map<string, () => void>>();

function replacePending(client: OBSWebSocketClient, inputName: string, cancel?: () => void): void {
  let byInput = pending.get(client);
  if (!byInput) pending.set(client, byInput = new Map());
  byInput.get(inputName)?.();
  if (cancel) byInput.set(inputName, cancel);
  else byInput.delete(inputName);
}

async function currentProgramScene(client: OBSWebSocketClient): Promise<string | undefined> {
  const program = await client.sendRequest("GetCurrentProgramScene") as JsonObject;
  const name = program.currentProgramSceneName ?? program.sceneName;
  return typeof name === "string" ? name : undefined;
}

export function initialize(server: McpServer, client: OBSWebSocketClient): void {
  server.registerTool(
    "obs-play-video",
    {
      title: "Play Video",
      description: "Play a video file on top of the stream in a graphic slot of the Overlays scene: once by default, "
        + "hiding itself when it ends, or looping until obs-graphic-hide. Its sound goes to the stream like any media source",
      inputSchema: z.object({
        file: z.string().min(1).describe("Absolute path of the video on the machine running OBS"),
        slot: z.string().min(1).max(64).regex(/^[\w .-]+$/).default("video").describe("Graphic slot to play in"),
        position: z.enum(POSITIONS).default("full").describe("Where on screen; full fits it inside the title-safe margin"),
        loop: z.boolean().default(false).describe("Loop until hidden instead of playing once"),
      }),
      annotations: NON_IDEMPOTENT_WRITE_TOOL,
    },
    async (args): Promise<CallToolResult> => {
      try {
        await client.connect();
        const missingFile = checkLocalFile(client, args.file);
        if (missingFile) return errorResult(missingFile);
        const [theme, canvas] = await Promise.all([loadTheme(), canvasSize(client)]);
        const nesting = await ensureOverlays(client);
        const inputName = slotInput(args.slot);
        clearSlotTimer(client, args.slot);
        replacePending(client, inputName);
        const { sceneItemId, created } = await placeSlot(client, {
          slot: args.slot,
          inputKind: MEDIA_KIND,
          inputSettings: mediaSettings(args.file, args.loop),
          transform: positionTransform(args.position as Position, canvas, theme.marginPercent),
        });
        if (!args.loop) {
          replacePending(client, inputName, onPlaybackEnded(client, inputName, () => {
            replacePending(client, inputName);
            hideSlot(client, args.slot).catch((error: unknown) => logger.error(`Could not hide ${inputName}: ${errorMessage(error)}`));
          }));
        }
        // An item already showing does not restart on activation.
        if (!created) await client.sendRequest("TriggerMediaInputAction", { inputName, mediaAction: RESTART });
        return {
          content: [{
            type: "text",
            text: [
              `Playing ${args.file} in slot ${args.slot} at ${args.position}${args.loop ? ", looping until obs-graphic-hide" : "; it hides when it ends"}`,
              ...(nesting.nestedInto.length > 0 ? [`Added Overlays on top of: ${nesting.nestedInto.join(", ")}`] : []),
            ].join("\n"),
          }],
          structuredContent: { slot: args.slot, inputName, sceneItemId, created, loop: args.loop, nestedInto: nesting.nestedInto },
        };
      } catch (error) {
        replacePending(client, slotInput(args.slot));
        return errorResult(`Play Video failed: ${errorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "obs-play-intro",
    {
      title: "Play Intro",
      description: "Play an intro video full screen in its own scene, then switch to thenScene when it ends. The intro "
        + "scene is kept free of the Overlays scene so the intro plays clean. Switches the program scene, so viewers see it at once",
      inputSchema: z.object({
        file: z.string().min(1).describe("Absolute path of the video on the machine running OBS"),
        thenScene: z.string().min(1).describe("Scene to switch to when the intro ends"),
        introScene: z.string().min(1).default("Intro").describe("Scene that plays the intro; created if missing"),
        maxSeconds: z.number().int().min(1).max(3600).default(600)
          .describe("Switch to thenScene after this long even if OBS never reports the end; needs this server to keep running"),
      }),
      annotations: NON_IDEMPOTENT_WRITE_TOOL,
    },
    async (args): Promise<CallToolResult> => {
      if (args.introScene === args.thenScene) return errorResult("introScene and thenScene must differ");
      const inputName = `${INTRO_PREFIX}${args.introScene}`;
      try {
        await client.connect();
        const missingFile = checkLocalFile(client, args.file);
        if (missingFile) return errorResult(missingFile);
        const target = await tryRequest(client, "GetSceneItemList", { sceneName: args.thenScene });
        if (!target.ok) return errorResult(`There is no scene named ${args.thenScene}`);
        const canvas = await canvasSize(client);
        const createdScene = await ensureScene(client, args.introScene);
        replacePending(client, inputName);

        const existing = await tryRequest(client, "GetInputSettings", { inputName });
        let sceneItemId: number;
        if (existing.ok) {
          await client.sendRequest("SetInputSettings", { inputName, inputSettings: mediaSettings(args.file, false), overlay: true });
          const found = await tryRequest(client, "GetSceneItemId", { sceneName: args.introScene, sourceName: inputName });
          sceneItemId = found.ok && isObject(found.responseData)
            ? Number(found.responseData.sceneItemId)
            : Number((await client.sendRequest("CreateSceneItem", { sceneName: args.introScene, sourceName: inputName }) as JsonObject).sceneItemId);
        } else {
          const response = await client.sendRequest("CreateInput", {
            sceneName: args.introScene,
            inputName,
            inputKind: MEDIA_KIND,
            inputSettings: mediaSettings(args.file, false),
            sceneItemEnabled: true,
          }) as JsonObject;
          sceneItemId = Number(response.sceneItemId);
        }
        await client.sendRequest("SetSceneItemTransform", { sceneName: args.introScene, sceneItemId, sceneItemTransform: fillTransform(canvas) });
        await client.sendRequest("SetSceneItemEnabled", { sceneName: args.introScene, sceneItemId, sceneItemEnabled: true });
        // The intro plays clean: take out graphics nested here before the scene held an intro.
        const introItems = await client.sendRequest("GetSceneItemList", { sceneName: args.introScene }) as { sceneItems?: unknown[] };
        await client.sendBatch((introItems.sceneItems ?? []).filter(isObject).filter(({ sourceName }) => sourceName === OVERLAY_SCENE)
          .map(({ sceneItemId: overlayItemId }) => ({ requestType: "RemoveSceneItem", requestData: { sceneName: args.introScene, sceneItemId: overlayItemId } })));

        // Leave the intro only if it is still on air, so a manual switch during the intro wins.
        const finish = (reason: string) => {
          replacePending(client, inputName);
          void (async () => {
            if (await currentProgramScene(client) !== args.introScene) return;
            await client.sendRequest("SetCurrentProgramScene", { sceneName: args.thenScene });
            logger.log(`Intro in ${args.introScene} ${reason}; switched to ${args.thenScene}`);
          })().catch((error: unknown) => logger.error(`Could not leave the intro: ${errorMessage(error)}`));
        };
        const stopWaiting = onPlaybackEnded(client, inputName, () => finish("ended"));
        const deadline = setTimeout(() => {
          stopWaiting();
          finish(`ran past ${args.maxSeconds}s`);
        }, args.maxSeconds * 1000);
        deadline.unref();
        replacePending(client, inputName, () => {
          stopWaiting();
          clearTimeout(deadline);
        });

        await client.sendRequest("SetCurrentProgramScene", { sceneName: args.introScene });
        await client.sendRequest("TriggerMediaInputAction", { inputName, mediaAction: RESTART });
        return {
          content: [{
            type: "text",
            text: `${createdScene ? `Created scene ${args.introScene}. ` : ""}Playing the intro in ${args.introScene}; `
              + `switches to ${args.thenScene} when it ends (at the latest after ${args.maxSeconds}s)`,
          }],
          structuredContent: { introScene: args.introScene, thenScene: args.thenScene, inputName, sceneItemId, createdScene, maxSeconds: args.maxSeconds },
        };
      } catch (error) {
        replacePending(client, inputName);
        return errorResult(`Play Intro failed: ${errorMessage(error)}`);
      }
    },
  );
}

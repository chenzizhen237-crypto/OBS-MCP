/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { existsSync } from "node:fs";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BatchResult, OBSWebSocketClient } from "../client.js";
import { logger } from "../logger.js";
import {
  loadTheme,
  mergeTheme,
  POSITIONS,
  positionTransform,
  saveTheme,
  TEXT_KINDS,
  textInputKind,
  textSettings,
  ThemeChangeSchema,
  themePath,
  type Position,
} from "./graphics-theme.js";
import { isLocalObs } from "./preflight.js";
import { IDEMPOTENT_WRITE_TOOL, READ_ONLY_TOOL } from "./request-tool.js";
import { screenshotResult } from "./screenshot.js";

type JsonObject = Record<string, unknown>;

/** The scene that holds every graphic; nested on top of other scenes so graphics survive scene switches. */
export const OVERLAY_SCENE = "Overlays";
/** Inputs this server manages in the Overlays scene: "Graphic: title". */
export const SLOT_PREFIX = "Graphic: ";
/** Media inputs that play intros; scenes holding one never get the Overlays scene. */
export const INTRO_PREFIX = "Intro video: ";

const SLOT_NAME = z.string().min(1).max(64).regex(/^[\w .-]+$/, "Use letters, digits, spaces, dots, dashes, and underscores");
const SCREENSHOT_WIDTH = 960;
const NOT_FOUND = 600;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function slotInput(slot: string): string {
  return `${SLOT_PREFIX}${slot}`;
}

/** One request whose failure code matters, e.g. 600 for something that does not exist. */
export async function tryRequest(client: OBSWebSocketClient, requestType: string, requestData?: JsonObject): Promise<BatchResult> {
  const [result] = await client.sendBatch([{ requestType, requestData }]);
  if (!result) throw new Error(`OBS returned no result for ${requestType}`);
  return result;
}

function failed(result: BatchResult): Error {
  return new Error(`${result.requestType} failed with code ${result.code}${result.comment ? `: ${result.comment}` : ""}`);
}

export async function canvasSize(client: OBSWebSocketClient): Promise<{ width: number; height: number }> {
  const video = await client.sendRequest("GetVideoSettings") as JsonObject;
  const width = Number(video.baseWidth);
  const height = Number(video.baseHeight);
  if (!(width > 0 && height > 0)) throw new Error("OBS did not report its canvas size");
  return { width, height };
}

async function sceneNames(client: OBSWebSocketClient): Promise<string[]> {
  const { scenes } = await client.sendRequest("GetSceneList") as { scenes?: unknown[] };
  return (scenes ?? []).filter(isObject).map(({ sceneName }) => sceneName).filter((name): name is string => typeof name === "string");
}

type SceneItem = { sceneItemId: number; sourceName: string; enabled: boolean; inputKind?: string; transform: JsonObject };

function sceneItems(response: unknown): SceneItem[] {
  const items = isObject(response) && Array.isArray(response.sceneItems) ? response.sceneItems.filter(isObject) : [];
  return items
    .filter((item) => typeof item.sceneItemId === "number" && typeof item.sourceName === "string")
    .map((item) => ({
      sceneItemId: item.sceneItemId as number,
      sourceName: item.sourceName as string,
      enabled: item.sceneItemEnabled !== false,
      ...(typeof item.inputKind === "string" ? { inputKind: item.inputKind } : {}),
      transform: isObject(item.sceneItemTransform) ? item.sceneItemTransform : {},
    }));
}

/** Creates a scene if there is none by that name; returns whether it did. */
export async function ensureScene(client: OBSWebSocketClient, sceneName: string): Promise<boolean> {
  if ((await sceneNames(client)).includes(sceneName)) return false;
  await client.sendRequest("CreateScene", { sceneName });
  return true;
}

/**
 * Creates the Overlays scene if needed, and puts it on top of every other
 * scene that does not have it yet. Scenes that play an intro are left out,
 * so the intro plays clean. Returns the scenes it was added to.
 */
export async function ensureOverlays(client: OBSWebSocketClient): Promise<{ created: boolean; nestedInto: string[] }> {
  const created = await ensureScene(client, OVERLAY_SCENE);
  const scenes = (await sceneNames(client)).filter((name) => name !== OVERLAY_SCENE);
  const lists = await client.sendBatch(scenes.map((sceneName) => ({ requestType: "GetSceneItemList", requestData: { sceneName } })));
  const missing = scenes.filter((_sceneName, index) => {
    const result = lists[index];
    if (!result?.ok) return false;
    const items = sceneItems(result.responseData);
    return !items.some(({ sourceName }) => sourceName === OVERLAY_SCENE || sourceName.startsWith(INTRO_PREFIX));
  });
  if (missing.length > 0) {
    // New scene items go on top, which is where graphics belong.
    const results = await client.sendBatch(missing.map((sceneName) => ({
      requestType: "CreateSceneItem",
      requestData: { sceneName, sourceName: OVERLAY_SCENE, sceneItemEnabled: true },
    })));
    const failure = results.find(({ ok }) => !ok);
    if (failure) throw failed(failure);
  }
  return { created, nestedInto: missing };
}

export type SlotSetup = {
  slot: string;
  inputKind: string;
  inputSettings: JsonObject;
  transform: JsonObject;
};

/**
 * Creates the slot's input in the Overlays scene, or updates the one there,
 * then places and shows it. Refuses to change a slot's input kind.
 */
export async function placeSlot(client: OBSWebSocketClient, setup: SlotSetup): Promise<{ sceneItemId: number; created: boolean }> {
  const inputName = slotInput(setup.slot);
  const current = await tryRequest(client, "GetInputSettings", { inputName });
  let created = false;
  let sceneItemId: number;
  if (!current.ok) {
    if (current.code !== NOT_FOUND) throw failed(current);
    const response = await client.sendRequest("CreateInput", {
      sceneName: OVERLAY_SCENE,
      inputName,
      inputKind: setup.inputKind,
      inputSettings: setup.inputSettings,
      sceneItemEnabled: true,
    }) as JsonObject;
    if (typeof response.sceneItemId !== "number") throw new Error("OBS did not return the new scene item");
    sceneItemId = response.sceneItemId;
    created = true;
  } else {
    const kind = isObject(current.responseData) ? current.responseData.inputKind : undefined;
    const sameFamily = kind === setup.inputKind || (TEXT_KINDS.has(String(kind)) && TEXT_KINDS.has(setup.inputKind));
    if (!sameFamily) {
      throw new Error(`Slot ${setup.slot} holds a ${String(kind)}, not a ${setup.inputKind}. Use another slot, or remove it with obs-graphic-hide remove:true`);
    }
    await client.sendRequest("SetInputSettings", { inputName, inputSettings: setup.inputSettings, overlay: true });
    const found = await tryRequest(client, "GetSceneItemId", { sceneName: OVERLAY_SCENE, sourceName: inputName });
    if (found.ok && isObject(found.responseData) && typeof found.responseData.sceneItemId === "number") {
      sceneItemId = found.responseData.sceneItemId;
    } else {
      const response = await client.sendRequest("CreateSceneItem", { sceneName: OVERLAY_SCENE, sourceName: inputName, sceneItemEnabled: true }) as JsonObject;
      sceneItemId = Number(response.sceneItemId);
    }
  }
  await client.sendBatch([
    { requestType: "SetSceneItemTransform", requestData: { sceneName: OVERLAY_SCENE, sceneItemId, sceneItemTransform: setup.transform } },
    { requestType: "SetSceneItemEnabled", requestData: { sceneName: OVERLAY_SCENE, sceneItemId, sceneItemEnabled: true } },
  ], { haltOnFailure: true }).then((results) => {
    const failure = results.find(({ ok }) => !ok);
    if (failure) throw failed(failure);
  });
  return { sceneItemId, created };
}

/** Hides a slot, or removes its input. Returns false when there is no such slot. */
export async function hideSlot(client: OBSWebSocketClient, slot: string, remove = false): Promise<boolean> {
  clearSlotTimer(client, slot);
  const inputName = slotInput(slot);
  if (remove) {
    const removed = await tryRequest(client, "RemoveInput", { inputName });
    if (!removed.ok && removed.code !== NOT_FOUND) throw failed(removed);
    return removed.ok;
  }
  const found = await tryRequest(client, "GetSceneItemId", { sceneName: OVERLAY_SCENE, sourceName: inputName });
  if (!found.ok || !isObject(found.responseData)) {
    if (found.code !== NOT_FOUND) throw failed(found);
    return false;
  }
  await client.sendRequest("SetSceneItemEnabled", { sceneName: OVERLAY_SCENE, sceneItemId: found.responseData.sceneItemId, sceneItemEnabled: false });
  return true;
}

type SlotTimer = { timer: NodeJS.Timeout; hideAt: string };
const slotTimers = new WeakMap<OBSWebSocketClient, Map<string, SlotTimer>>();

function timersFor(client: OBSWebSocketClient): Map<string, SlotTimer> {
  let timers = slotTimers.get(client);
  if (!timers) slotTimers.set(client, timers = new Map());
  return timers;
}

export function clearSlotTimer(client: OBSWebSocketClient, slot: string): void {
  const timers = timersFor(client);
  clearTimeout(timers.get(slot)?.timer);
  timers.delete(slot);
}

/** Hides the slot after `seconds`, replacing any earlier timer. Needs this process to stay running. */
export function hideSlotLater(client: OBSWebSocketClient, slot: string, seconds: number): string {
  clearSlotTimer(client, slot);
  const hideAt = new Date(Date.now() + seconds * 1000).toISOString();
  const timer = setTimeout(() => {
    timersFor(client).delete(slot);
    hideSlot(client, slot).catch((error: unknown) => logger.error(`Could not hide graphic ${slot}: ${errorMessage(error)}`));
  }, seconds * 1000);
  timer.unref();
  timersFor(client).set(slot, { timer, hideAt });
  return hideAt;
}

export function slotHideAt(client: OBSWebSocketClient, slot: string): string | undefined {
  return timersFor(client).get(slot)?.hideAt;
}

/** A screenshot of the program scene, appended to a result; a failed screenshot becomes a note. */
export async function withProgramScreenshot(client: OBSWebSocketClient, result: CallToolResult): Promise<CallToolResult> {
  try {
    const program = await client.sendRequest("GetCurrentProgramScene") as JsonObject;
    const sourceName = program.currentProgramSceneName ?? program.sceneName;
    const shot = screenshotResult(await client.sendRequest("GetSourceScreenshot", { sourceName, imageFormat: "jpeg", imageWidth: SCREENSHOT_WIDTH }));
    return { ...result, content: [...result.content, ...shot.content.filter((block) => block.type === "image")] };
  } catch (error) {
    return { ...result, content: [...result.content, { type: "text", text: `No screenshot: ${errorMessage(error)}` }] };
  }
}

/** Refuses a local file that does not exist when OBS runs on this machine; a remote OBS checks its own. */
export function checkLocalFile(client: OBSWebSocketClient, file: string): string | undefined {
  if (isLocalObs(client) && !existsSync(file)) return `${file} does not exist on this machine`;
  return undefined;
}

export type SlotInfo = {
  slot: string;
  inputName: string;
  inputKind: string | null;
  visible: boolean;
  text?: string;
  file?: string;
  sceneItemId: number;
  position: { x: number | null; y: number | null; alignment: number | null };
  hideAt?: string;
};

export async function listSlots(client: OBSWebSocketClient): Promise<{ slots: SlotInfo[]; overlaysIn: string[]; overlaysMissingFrom: string[] }> {
  const scenes = await sceneNames(client);
  if (!scenes.includes(OVERLAY_SCENE)) return { slots: [], overlaysIn: [], overlaysMissingFrom: scenes };
  const others = scenes.filter((name) => name !== OVERLAY_SCENE);
  const lists = await client.sendBatch([OVERLAY_SCENE, ...others].map((sceneName) => ({ requestType: "GetSceneItemList", requestData: { sceneName } })));
  const overlayItems = lists[0]?.ok ? sceneItems(lists[0].responseData) : [];
  const overlaysIn: string[] = [];
  const overlaysMissingFrom: string[] = [];
  others.forEach((sceneName, index) => {
    const items = lists[index + 1]?.ok ? sceneItems(lists[index + 1]!.responseData) : [];
    if (items.some(({ sourceName }) => sourceName.startsWith(INTRO_PREFIX))) return;
    (items.some(({ sourceName }) => sourceName === OVERLAY_SCENE) ? overlaysIn : overlaysMissingFrom).push(sceneName);
  });
  const managed = overlayItems.filter(({ sourceName }) => sourceName.startsWith(SLOT_PREFIX));
  const settings = await client.sendBatch(managed.map(({ sourceName }) => ({ requestType: "GetInputSettings", requestData: { inputName: sourceName } })));
  const number = (value: unknown) => (typeof value === "number" ? value : null);
  const slots = managed.map((item, index): SlotInfo => {
    const result = settings[index];
    const data = result?.ok && isObject(result.responseData) ? result.responseData : {};
    const inputSettings = isObject(data.inputSettings) ? data.inputSettings : {};
    const slot = item.sourceName.slice(SLOT_PREFIX.length);
    const hideAt = slotHideAt(client, slot);
    return {
      slot,
      inputName: item.sourceName,
      inputKind: typeof data.inputKind === "string" ? data.inputKind : item.inputKind ?? null,
      visible: item.enabled,
      ...(typeof inputSettings.text === "string" ? { text: inputSettings.text } : {}),
      ...(typeof inputSettings.file === "string" ? { file: inputSettings.file } : {}),
      ...(typeof inputSettings.local_file === "string" ? { file: inputSettings.local_file } : {}),
      sceneItemId: item.sceneItemId,
      position: { x: number(item.transform.positionX), y: number(item.transform.positionY), alignment: number(item.transform.alignment) },
      ...(hideAt ? { hideAt } : {}),
    };
  });
  return { slots, overlaysIn, overlaysMissingFrom };
}

function describeNesting(created: boolean, nestedInto: string[]): string[] {
  return [
    ...(created ? [`Created the ${OVERLAY_SCENE} scene`] : []),
    ...(nestedInto.length > 0 ? [`Added ${OVERLAY_SCENE} on top of: ${nestedInto.join(", ")}`] : []),
  ];
}

export function initialize(server: McpServer, client: OBSWebSocketClient): void {
  server.registerTool(
    "obs-graphic-show",
    {
      title: "Show Graphic",
      description: "Show a title, caption, or image on screen in a named slot, styled by the package theme. "
        + `Graphics live in the ${OVERLAY_SCENE} scene, which is added on top of every scene so they stay up across `
        + "scene switches. Showing a slot again updates it in place. Positions are words and stay inside the "
        + "title-safe margin at any canvas size. Returns a screenshot of the program scene",
      inputSchema: z.object({
        slot: SLOT_NAME.default("title").describe("Name of the graphic, e.g. title, guest, logo; one graphic per slot"),
        text: z.string().min(1).max(500).optional().describe("Text to show; give this or image"),
        image: z.string().min(1).optional().describe("Absolute path of an image file on the machine running OBS; give this or text"),
        position: z.enum(POSITIONS).default("lower-third").describe("Where on screen"),
        seconds: z.number().int().min(1).max(3600).optional().describe("Hide after this many seconds; needs this server to keep running"),
        style: z.object({
          size: z.number().int().min(8).max(512).optional().describe("Font size at 1080p"),
          color: z.string().regex(/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i).optional().describe("Text color, #RRGGBB"),
          font: z.string().min(1).optional().describe("Font family"),
        }).optional().describe("Overrides for this graphic only; the theme stays the same"),
        includeScreenshot: z.boolean().default(true),
      }),
      annotations: IDEMPOTENT_WRITE_TOOL,
    },
    async (args) => {
      if (!args.text === !args.image) return errorResult("Give exactly one of text or image");
      try {
        await client.connect();
        const missingFile = args.image ? checkLocalFile(client, args.image) : undefined;
        if (missingFile) return errorResult(missingFile);
        const [theme, canvas] = await Promise.all([loadTheme(), canvasSize(client)]);
        const styled = args.style
          ? mergeTheme(theme, {
            font: { ...(args.style.size ? { size: args.style.size } : {}), ...(args.style.font ? { face: args.style.font } : {}) },
            ...(args.style.color ? { textColor: args.style.color } : {}),
          })
          : theme;
        const inputKind = args.text ? textInputKind(String(client.getConnectionStatus().versionInfo?.platform ?? "")) : "image_source";
        const inputSettings = args.text ? textSettings(inputKind, args.text, styled, canvas.height) : { file: args.image };
        const nesting = await ensureOverlays(client);
        const { sceneItemId, created } = await placeSlot(client, {
          slot: args.slot,
          inputKind,
          inputSettings,
          transform: positionTransform(args.position as Position, canvas, theme.marginPercent),
        });
        const hideAt = args.seconds ? hideSlotLater(client, args.slot, args.seconds) : undefined;
        if (!args.seconds) clearSlotTimer(client, args.slot);
        const lines = [
          `${created ? "Showing" : "Updated"} ${args.text ? `"${args.text}"` : args.image} in slot ${args.slot} at ${args.position}`,
          ...describeNesting(nesting.created, nesting.nestedInto),
          ...(args.seconds ? [`Hides after ${args.seconds}s`] : []),
        ];
        const result: CallToolResult = {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: {
            slot: args.slot,
            inputName: slotInput(args.slot),
            inputKind,
            sceneName: OVERLAY_SCENE,
            sceneItemId,
            created,
            position: args.position,
            nestedInto: nesting.nestedInto,
            ...(hideAt ? { hideAt } : {}),
          },
        };
        return args.includeScreenshot ? withProgramScreenshot(client, result) : result;
      } catch (error) {
        return errorResult(`Show Graphic failed: ${errorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "obs-graphic-hide",
    {
      title: "Hide Graphic",
      description: "Hide a graphic slot shown with obs-graphic-show or obs-play-video. With remove:true, delete its input too",
      inputSchema: z.object({
        slot: SLOT_NAME.default("title"),
        remove: z.boolean().default(false).describe("Delete the slot's input instead of hiding it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ slot, remove }) => {
      try {
        await client.connect();
        const done = await hideSlot(client, slot, remove);
        if (!done) return errorResult(`No graphic in slot ${slot}; obs-graphic-list shows the slots`);
        return { content: [{ type: "text", text: `${remove ? "Removed" : "Hid"} slot ${slot}` }], structuredContent: { slot, removed: remove } };
      } catch (error) {
        return errorResult(`Hide Graphic failed: ${errorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "obs-graphic-list",
    {
      title: "List Graphics",
      description: `List the graphic slots in the ${OVERLAY_SCENE} scene with their text or file, visibility, `
        + `position, and hide timer, and which scenes show the ${OVERLAY_SCENE} scene`,
      inputSchema: z.object({}),
      annotations: READ_ONLY_TOOL,
    },
    async () => {
      try {
        await client.connect();
        const { slots, overlaysIn, overlaysMissingFrom } = await listSlots(client);
        const lines = slots.length === 0
          ? ["No graphics yet; add one with obs-graphic-show"]
          : slots.map((slot) => `${slot.slot}: ${slot.visible ? "showing" : "hidden"}, ${slot.text !== undefined ? `"${slot.text}"` : slot.file ?? slot.inputKind}`
            + (slot.hideAt ? `, hides at ${slot.hideAt}` : ""));
        if (overlaysMissingFrom.length > 0 && slots.length > 0) {
          lines.push(`Not shown in: ${overlaysMissingFrom.join(", ")} (the next obs-graphic-show adds ${OVERLAY_SCENE} there)`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { overlayScene: OVERLAY_SCENE, slots, overlaysIn, overlaysMissingFrom } };
      } catch (error) {
        return errorResult(`List Graphics failed: ${errorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    "obs-package-theme",
    {
      title: "Graphics Theme",
      description: "Read or change the package theme that styles every graphic: font, size, text color, outline, "
        + "shadow, and margin. Stored as theme.json in the package folder (OBS_MCP_PACKAGE_DIR). With changes, "
        + "existing text graphics are restyled unless restyle is false",
      inputSchema: z.object({
        set: ThemeChangeSchema.optional().describe("Fields to change; leave out to read the theme"),
        restyle: z.boolean().default(true).describe("Apply the new style to text graphics already on screen"),
      }),
      annotations: IDEMPOTENT_WRITE_TOOL,
    },
    async ({ set, restyle }) => {
      try {
        const path = themePath();
        let theme = await loadTheme(path);
        const restyled: string[] = [];
        if (set) {
          theme = mergeTheme(theme, set);
          await saveTheme(theme, path);
          if (restyle) {
            await client.connect();
            const [{ slots }, canvas] = await Promise.all([listSlots(client), canvasSize(client)]);
            const texts = slots.filter((slot) => slot.text !== undefined && slot.inputKind && TEXT_KINDS.has(slot.inputKind));
            const results = await client.sendBatch(texts.map((slot) => ({
              requestType: "SetInputSettings",
              requestData: { inputName: slot.inputName, inputSettings: textSettings(slot.inputKind!, slot.text!, theme, canvas.height), overlay: true },
            })));
            texts.forEach((slot, index) => { if (results[index]?.ok) restyled.push(slot.slot); });
          }
        }
        return {
          content: [{
            type: "text",
            text: `${set ? "Saved" : "Theme from"} ${path}\n${JSON.stringify(theme, null, 2)}`
              + (restyled.length > 0 ? `\nRestyled: ${restyled.join(", ")}` : ""),
          }],
          structuredContent: { path, theme, restyled },
        };
      } catch (error) {
        return errorResult(`Graphics Theme failed: ${errorMessage(error)}`);
      }
    },
  );
}

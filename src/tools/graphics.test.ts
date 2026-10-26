/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSceneState, newInput, serveSceneState, type FakeSceneState } from "../../test/support/fake-obs-scene.js";
import { resultText, startMcpHarness, type McpHarness } from "../../test/support/mcp-harness.js";
import { themePath } from "./graphics-theme.js";

let harness: McpHarness;
let state: FakeSceneState;
let directory: string;

const JPEG = "data:image/jpeg;base64,/9j/4AAQ";

async function startHarness(platform = "macos"): Promise<void> {
  harness = await startMcpHarness({ platform });
  serveSceneState(harness.fakeObs, state);
  harness.fakeObs.respondWith("GetSourceScreenshot", () => ({ imageData: JPEG }));
}

const overlayItems = () => state.scenes.Overlays ?? [];
const slotItem = (slot: string) => overlayItems().find(({ sourceName }) => sourceName === `Graphic: ${slot}`);

async function show(args: Record<string, unknown>) {
  const result = await harness.call("obs-graphic-show", { includeScreenshot: false, ...args });
  return { result, data: result.structuredContent as Record<string, unknown> };
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  directory = mkdtempSync(join(tmpdir(), "obs-mcp-graphics-"));
  state = demoSceneState();
  state.scenes.Main = [];
  await startHarness();
});

afterEach(async () => {
  await harness.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("obs-graphic-show", () => {
  it("creates the Overlays scene, nests it on top of every scene, and shows a themed title", async () => {
    const { result, data } = await show({ text: "Day 3: building an OBS MCP" });

    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("Created the Overlays scene");
    expect(data).toMatchObject({ slot: "title", inputKind: "text_ft2_source_v2", created: true, position: "lower-third" });
    expect((data.nestedInto as string[]).sort()).toEqual(["Demo", "Main"]);
    expect(state.scenes.Demo!.at(-1)!.sourceName).toBe("Overlays");
    expect(state.scenes.Main!.at(-1)!.sourceName).toBe("Overlays");
    expect(state.inputs["Graphic: title"]).toMatchObject({
      kind: "text_ft2_source_v2",
      settings: { text: "Day 3: building an OBS MCP", font: { face: "Helvetica", size: 56, style: "Bold", flags: 1 }, color1: 0xFFFFFFFF },
    });
    expect(slotItem("title")).toMatchObject({ enabled: true, transform: { alignment: 9, positionX: 96, positionY: 918 } });
  });

  it("updates the same graphic when shown again, without nesting twice", async () => {
    await show({ text: "First" });
    const { result, data } = await show({ text: "Second", position: "top-right" });

    expect(resultText(result)).toMatch(/^Updated "Second" in slot title at top-right/);
    expect(data).toMatchObject({ created: false, nestedInto: [] });
    expect(overlayItems().filter(({ sourceName }) => sourceName === "Graphic: title")).toHaveLength(1);
    expect(state.scenes.Demo!.filter(({ sourceName }) => sourceName === "Overlays")).toHaveLength(1);
    expect(state.inputs["Graphic: title"]!.settings.text).toBe("Second");
    expect(slotItem("title")!.transform).toMatchObject({ alignment: 6, positionX: 1824, positionY: 54 });
  });

  it("shows a hidden slot again", async () => {
    await show({ text: "Back" });
    await harness.call("obs-graphic-hide", { slot: "title" });
    expect(slotItem("title")!.enabled).toBe(false);
    await show({ text: "Back" });
    expect(slotItem("title")!.enabled).toBe(true);
  });

  it("uses GDI+ text on Windows", async () => {
    await harness.close();
    await startHarness("windows");
    const { data } = await show({ text: "Hi", style: { color: "#FF0000", size: 80 } });
    expect(data.inputKind).toBe("text_gdiplus_v3");
    expect(state.inputs["Graphic: title"]!.settings).toMatchObject({ color: 0x0000FF, opacity: 100, font: { size: 80 } });
  });

  it("shows an image that exists, and refuses one that does not", async () => {
    const logo = join(directory, "logo.png");
    writeFileSync(logo, "png");
    const { data } = await show({ slot: "logo", image: logo, position: "top-right" });
    expect(data).toMatchObject({ inputKind: "image_source" });
    expect(state.inputs["Graphic: logo"]!.settings).toEqual({ file: logo });

    const missing = await show({ slot: "logo2", image: join(directory, "missing.png") });
    expect(missing.result.isError).toBe(true);
    expect(resultText(missing.result)).toContain("does not exist");
  });

  it("refuses to change a slot's kind, and needs exactly one of text or image", async () => {
    await show({ slot: "logo", text: "words" });
    const logo = join(directory, "logo.png");
    writeFileSync(logo, "png");
    const clash = await show({ slot: "logo", image: logo });
    expect(clash.result.isError).toBe(true);
    expect(resultText(clash.result)).toContain("holds a text_ft2_source_v2");

    expect((await show({})).result.isError).toBe(true);
    expect((await show({ text: "a", image: logo })).result.isError).toBe(true);
  });

  it("hides after the given seconds", async () => {
    const { data } = await show({ text: "Brief", seconds: 1 });
    expect(data.hideAt).toEqual(expect.any(String));
    await vi.waitFor(() => expect(slotItem("title")!.enabled).toBe(false), { timeout: 3000 });
  });

  it("keeps the graphic when shown again without seconds", async () => {
    await show({ text: "Brief", seconds: 1 });
    await show({ text: "Stays" });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(slotItem("title")!.enabled).toBe(true);
  });

  it("returns a screenshot of the program scene", async () => {
    const result = await harness.call("obs-graphic-show", { text: "Look" });
    expect(result.content.some((block) => block.type === "image")).toBe(true);
  });

  it("adds Overlays to scenes created later, but not to intro scenes", async () => {
    await show({ text: "One" });
    state.scenes.Later = [];
    state.inputs["Intro video: Intro"] = newInput("ffmpeg_source");
    state.scenes.Intro = [{ sceneItemId: 99, sourceName: "Intro video: Intro", enabled: true, locked: false, transform: {} }];
    const { data } = await show({ text: "Two" });
    expect(data.nestedInto).toEqual(["Later"]);
    expect(state.scenes.Intro!.some(({ sourceName }) => sourceName === "Overlays")).toBe(false);
  });
});

describe("obs-graphic-hide and obs-graphic-list", () => {
  it("lists slots with their text, visibility, and nesting", async () => {
    expect(resultText(await harness.call("obs-graphic-list"))).toContain("No graphics yet");
    await show({ text: "Title", seconds: 60 });
    await show({ slot: "guest", text: "Ana Lima" });
    await harness.call("obs-graphic-hide", { slot: "guest" });

    const result = await harness.call("obs-graphic-list");
    const data = result.structuredContent as { slots: Record<string, unknown>[]; overlaysIn: string[] };
    expect(data.slots).toEqual([
      expect.objectContaining({ slot: "title", text: "Title", visible: true, hideAt: expect.any(String), position: { x: 96, y: 918, alignment: 9 } }),
      expect.objectContaining({ slot: "guest", text: "Ana Lima", visible: false }),
    ]);
    expect(data.overlaysIn.sort()).toEqual(["Demo", "Main"]);
    expect(resultText(result)).toContain("guest: hidden");
  });

  it("removes a slot's input, and reports a slot that does not exist", async () => {
    await show({ text: "Gone soon" });
    const removed = await harness.call("obs-graphic-hide", { slot: "title", remove: true });
    expect(resultText(removed)).toBe("Removed slot title");
    expect(state.inputs["Graphic: title"]).toBeUndefined();
    expect(slotItem("title")).toBeUndefined();

    const missing = await harness.call("obs-graphic-hide", { slot: "nothing" });
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toContain("No graphic in slot nothing");
  });

  it("cancels a pending hide timer when hidden by hand", async () => {
    await show({ text: "Timer", seconds: 1 });
    await harness.call("obs-graphic-hide", { slot: "title" });
    await show({ text: "Timer again" });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(slotItem("title")!.enabled).toBe(true);
  });
});

describe("obs-package-theme", () => {
  it("reads the default theme, saves changes, and restyles text already on screen", async () => {
    const read = await harness.call("obs-package-theme", {});
    expect(read.structuredContent).toMatchObject({ theme: { textColor: "#FFFFFF" }, restyled: [] });

    await show({ text: "Restyle me" });
    const saved = await harness.call("obs-package-theme", { set: { textColor: "#FFCC00", font: { size: 72 } } });
    expect(saved.isError).toBeFalsy();
    expect(saved.structuredContent).toMatchObject({ restyled: ["title"], theme: { textColor: "#FFCC00", font: { size: 72, face: "Helvetica" } } });
    expect(JSON.parse(readFileSync(themePath(), "utf8"))).toMatchObject({ textColor: "#FFCC00" });
    expect(state.inputs["Graphic: title"]!.settings).toMatchObject({ text: "Restyle me", color1: 0xFF00CCFF, font: { size: 72 } });

    const next = await show({ slot: "second", text: "New one" });
    expect(next.result.isError).toBeFalsy();
    expect(state.inputs["Graphic: second"]!.settings).toMatchObject({ color1: 0xFF00CCFF });
  });

  it("rejects invalid colors without saving", async () => {
    const result = await harness.call("obs-package-theme", { set: { textColor: "yellow" } });
    expect(result.isError).toBe(true);
  });
});

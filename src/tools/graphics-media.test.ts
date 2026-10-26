/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSceneState, serveSceneState, type FakeSceneState } from "../../test/support/fake-obs-scene.js";
import { resultText, startMcpHarness, type McpHarness } from "../../test/support/mcp-harness.js";

let harness: McpHarness;
let state: FakeSceneState;
let directory: string;
let video: string;

const mediaActions = () => harness.fakeObs.history()
  .filter(({ frame }) => frame.d.requestType === "TriggerMediaInputAction")
  .map(({ frame }) => frame.d.requestData as Record<string, unknown>);

function playbackEnded(inputName: string): void {
  harness.fakeObs.sendEvent("MediaInputPlaybackEnded", { inputName, inputUuid: "uuid" });
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  directory = mkdtempSync(join(tmpdir(), "obs-mcp-media-"));
  video = join(directory, "clip.mp4");
  writeFileSync(video, "mp4");
  state = demoSceneState();
  state.scenes.Main = [];
  harness = await startMcpHarness();
  serveSceneState(harness.fakeObs, state);
});

afterEach(async () => {
  await harness.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("obs-play-video", () => {
  it("plays a file on top of the stream once and hides it when it ends", async () => {
    const result = await harness.call("obs-play-video", { file: video });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("it hides when it ends");
    expect(state.inputs["Graphic: video"]).toMatchObject({
      kind: "ffmpeg_source",
      settings: { is_local_file: true, local_file: video, looping: false, restart_on_activate: true, close_when_inactive: true },
    });
    const item = state.scenes.Overlays!.find(({ sourceName }) => sourceName === "Graphic: video")!;
    expect(item).toMatchObject({ enabled: true, transform: { boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 1728, boundsHeight: 972 } });
    expect(state.scenes.Demo!.at(-1)!.sourceName).toBe("Overlays");

    playbackEnded("Graphic: other");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(item.enabled).toBe(true);
    playbackEnded("Graphic: video");
    await vi.waitFor(() => expect(item.enabled).toBe(false));
  });

  it("keeps a looping video until it is hidden", async () => {
    await harness.call("obs-play-video", { file: video, slot: "bg", loop: true, position: "center" });
    const item = state.scenes.Overlays!.find(({ sourceName }) => sourceName === "Graphic: bg")!;
    playbackEnded("Graphic: bg");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(item.enabled).toBe(true);
    expect(state.inputs["Graphic: bg"]!.settings.looping).toBe(true);

    await harness.call("obs-graphic-hide", { slot: "bg" });
    expect(item.enabled).toBe(false);
  });

  it("restarts a video that is played again", async () => {
    await harness.call("obs-play-video", { file: video });
    expect(mediaActions()).toEqual([]);
    const again = await harness.call("obs-play-video", { file: video });
    expect(again.structuredContent).toMatchObject({ created: false });
    expect(mediaActions()).toEqual([{ inputName: "Graphic: video", mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART" }]);
  });

  it("refuses a file that does not exist", async () => {
    const result = await harness.call("obs-play-video", { file: join(directory, "missing.mp4") });
    expect(result.isError).toBe(true);
    expect(state.inputs["Graphic: video"]).toBeUndefined();
  });
});

describe("obs-play-intro", () => {
  it("plays the intro full screen in its own scene, then switches to the target scene", async () => {
    const result = await harness.call("obs-play-intro", { file: video, thenScene: "Main" });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("Created scene Intro");
    expect(state.program).toBe("Intro");
    expect(state.scenes.Intro).toEqual([
      expect.objectContaining({ sourceName: "Intro video: Intro", enabled: true, transform: expect.objectContaining({ boundsWidth: 1920, boundsHeight: 1080, positionX: 0 }) }),
    ]);
    expect(state.inputs["Intro video: Intro"]!.settings).toMatchObject({ local_file: video, looping: false });
    expect(mediaActions()).toEqual([{ inputName: "Intro video: Intro", mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART" }]);

    playbackEnded("Intro video: Intro");
    await vi.waitFor(() => expect(state.program).toBe("Main"));
  });

  it("keeps the intro scene clean when graphics are added later", async () => {
    await harness.call("obs-play-intro", { file: video, thenScene: "Main" });
    await harness.call("obs-graphic-show", { text: "Title", includeScreenshot: false });
    expect(state.scenes.Intro!.some(({ sourceName }) => sourceName === "Overlays")).toBe(false);
    expect(state.scenes.Main!.some(({ sourceName }) => sourceName === "Overlays")).toBe(true);
  });

  it("takes graphics out of an intro scene that had them before", async () => {
    state.scenes.Intro = [];
    await harness.call("obs-graphic-show", { text: "Title", includeScreenshot: false });
    expect(state.scenes.Intro.some(({ sourceName }) => sourceName === "Overlays")).toBe(true);

    await harness.call("obs-play-intro", { file: video, thenScene: "Main" });
    expect(state.scenes.Intro!.map(({ sourceName }) => sourceName)).toEqual(["Intro video: Intro"]);
  });

  it("does not switch when someone already left the intro", async () => {
    await harness.call("obs-play-intro", { file: video, thenScene: "Main" });
    state.program = "Demo";
    playbackEnded("Intro video: Intro");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.program).toBe("Demo");
  });

  it("switches after maxSeconds when OBS never reports the end", async () => {
    await harness.call("obs-play-intro", { file: video, thenScene: "Main", maxSeconds: 1 });
    expect(state.program).toBe("Intro");
    await vi.waitFor(() => expect(state.program).toBe("Main"), { timeout: 3000 });
  });

  it("reuses the intro input on a second run, and only the latest run switches", async () => {
    await harness.call("obs-play-intro", { file: video, thenScene: "Main" });
    const second = await harness.call("obs-play-intro", { file: video, thenScene: "Demo" });
    expect(resultText(second)).not.toContain("Created scene");
    expect(state.scenes.Intro).toHaveLength(1);
    playbackEnded("Intro video: Intro");
    await vi.waitFor(() => expect(state.program).toBe("Demo"));
  });

  it("refuses a missing target scene or the same scene twice", async () => {
    const missing = await harness.call("obs-play-intro", { file: video, thenScene: "Nowhere" });
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toContain("no scene named Nowhere");
    expect((await harness.call("obs-play-intro", { file: video, thenScene: "Intro" })).isError).toBe(true);
    expect(state.program).toBe("Demo");
  });
});

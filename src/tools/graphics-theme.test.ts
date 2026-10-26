/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  fillTransform,
  loadTheme,
  mergeTheme,
  packageDirectory,
  positionTransform,
  saveTheme,
  textInputKind,
  textSettings,
  themePath,
  toAbgr,
} from "./graphics-theme.js";

const HD = { width: 1920, height: 1080 };

describe("positionTransform", () => {
  it("places items at named positions inside a 5% margin", () => {
    expect(positionTransform("top-left", HD, 5)).toMatchObject({ alignment: 5, positionX: 96, positionY: 54, boundsType: "OBS_BOUNDS_NONE" });
    expect(positionTransform("top", HD, 5)).toMatchObject({ alignment: 4, positionX: 960, positionY: 54 });
    expect(positionTransform("center", HD, 5)).toMatchObject({ alignment: 0, positionX: 960, positionY: 540 });
    expect(positionTransform("right", HD, 5)).toMatchObject({ alignment: 2, positionX: 1824, positionY: 540 });
    expect(positionTransform("bottom-right", HD, 5)).toMatchObject({ alignment: 10, positionX: 1824, positionY: 1026 });
    expect(positionTransform("bottom", HD, 5)).toMatchObject({ alignment: 8, positionX: 960, positionY: 1026 });
  });

  it("puts a lower third above the bottom margin, left aligned", () => {
    expect(positionTransform("lower-third", HD, 5)).toMatchObject({ alignment: 9, positionX: 96, positionY: 918 });
  });

  it("fits full-screen items inside the margin, and scales with the canvas", () => {
    expect(positionTransform("full", HD, 5)).toMatchObject({
      alignment: 0, positionX: 960, positionY: 540, boundsType: "OBS_BOUNDS_SCALE_INNER", boundsWidth: 1728, boundsHeight: 972,
    });
    expect(positionTransform("bottom-right", { width: 3840, height: 2160 }, 5)).toMatchObject({ positionX: 3648, positionY: 2052 });
    expect(fillTransform(HD)).toMatchObject({ alignment: 5, positionX: 0, positionY: 0, boundsWidth: 1920, boundsHeight: 1080 });
  });
});

describe("text settings", () => {
  it("picks GDI+ text on Windows and FreeType elsewhere", () => {
    expect(textInputKind("windows")).toBe("text_gdiplus_v3");
    expect(textInputKind("macos")).toBe("text_ft2_source_v2");
    expect(textInputKind("ubuntu")).toBe("text_ft2_source_v2");
  });

  it("converts colors to OBS's byte order", () => {
    expect(toAbgr("#FF0000")).toBe(0xFF0000FF);
    expect(toAbgr("#80112233")).toBe(0x80332211);
  });

  it("writes FreeType settings with color, outline, shadow, and bold flags", () => {
    expect(textSettings("text_ft2_source_v2", "Day 3", DEFAULT_THEME)).toEqual({
      text: "Day 3",
      font: { face: "Helvetica", size: 56, style: "Bold", flags: 1 },
      color1: 0xFFFFFFFF,
      color2: 0xFFFFFFFF,
      outline: true,
      drop_shadow: true,
    });
  });

  it("writes GDI+ settings with BGR colors and opacity", () => {
    const theme = mergeTheme(DEFAULT_THEME, { textColor: "#80FF0000", outline: { color: "#00FF00" } });
    expect(textSettings("text_gdiplus_v3", "Hi", theme)).toMatchObject({
      text: "Hi", color: 0x0000FF, opacity: 50, outline: true, outline_size: 4, outline_color: 0x00FF00, outline_opacity: 100,
    });
  });

  it("scales the font with the canvas height", () => {
    expect(textSettings("text_ft2_source_v2", "x", DEFAULT_THEME, 2160)).toMatchObject({ font: { size: 112 } });
    expect(textSettings("text_ft2_source_v2", "x", DEFAULT_THEME, 720)).toMatchObject({ font: { size: 37 } });
  });
});

describe("theme file", () => {
  it("lives in the state directory unless OBS_MCP_PACKAGE_DIR is set", () => {
    expect(packageDirectory({ OBS_MCP_STATE_DIR: "/state" })).toBe(join("/state", "package"));
    expect(packageDirectory({ OBS_MCP_STATE_DIR: "/state", OBS_MCP_PACKAGE_DIR: "/brand" })).toBe("/brand");
  });

  it("defaults when missing, merges a partial file over the defaults, and saves", async () => {
    expect(await loadTheme()).toEqual(DEFAULT_THEME);
    mkdirSync(packageDirectory(), { recursive: true });
    writeFileSync(themePath(), JSON.stringify({ font: { size: 72 }, textColor: "#FFCC00" }));
    expect(await loadTheme()).toEqual({ ...DEFAULT_THEME, font: { ...DEFAULT_THEME.font, size: 72 }, textColor: "#FFCC00" });

    await saveTheme(mergeTheme(DEFAULT_THEME, { shadow: false }));
    expect((await loadTheme()).shadow).toBe(false);
  });

  it("names the problem in an invalid file", async () => {
    mkdirSync(packageDirectory(), { recursive: true });
    writeFileSync(themePath(), JSON.stringify({ textColor: "yellow" }));
    await expect(loadTheme()).rejects.toThrow(/textColor: Use #RRGGBB/);
    writeFileSync(themePath(), "{ nope");
    await expect(loadTheme()).rejects.toThrow(/not valid JSON/);
  });
});

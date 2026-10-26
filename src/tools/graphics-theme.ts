/*
 * Modified for the independent OBS MCP project in October 2026.
 * See NOTICE.md and Git history for authorship and change dates.
 * SPDX-License-Identifier: GPL-2.0-only
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { stateDirectory } from "../state-dir.js";

type JsonObject = Record<string, unknown>;

const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const color = z.string().regex(HEX_COLOR, "Use #RRGGBB or #AARRGGBB");

export const ThemeSchema = z.object({
  font: z.object({
    face: z.string().min(1).describe("Font family installed on the machine running OBS"),
    size: z.number().int().min(8).max(512).describe("Point size at a 1080p canvas; scaled for other canvas heights"),
    style: z.string().min(1).describe("Font style name, e.g. Regular or Bold"),
  }),
  textColor: color.describe("Text color as #RRGGBB or #AARRGGBB"),
  outline: z.object({
    enabled: z.boolean(),
    color: color.describe("Outline color; Windows text only, macOS and Linux outlines are black"),
    size: z.number().int().min(1).max(20),
  }),
  shadow: z.boolean().describe("Drop shadow; macOS and Linux text only"),
  marginPercent: z.number().min(0).max(20).describe("Distance from the canvas edge, as a percentage of its width and height"),
});

export type Theme = z.infer<typeof ThemeSchema>;

export const ThemeChangeSchema = z.object({
  font: ThemeSchema.shape.font.partial().optional(),
  textColor: ThemeSchema.shape.textColor.optional(),
  outline: ThemeSchema.shape.outline.partial().optional(),
  shadow: ThemeSchema.shape.shadow.optional(),
  marginPercent: ThemeSchema.shape.marginPercent.optional(),
});

export type ThemeChange = z.infer<typeof ThemeChangeSchema>;

export const DEFAULT_THEME: Theme = {
  font: { face: "Helvetica", size: 56, style: "Bold" },
  textColor: "#FFFFFF",
  outline: { enabled: true, color: "#000000", size: 4 },
  shadow: true,
  marginPercent: 5,
};

/** OBS_MCP_PACKAGE_DIR, or package/ in the server's state directory. */
export function packageDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.OBS_MCP_PACKAGE_DIR || join(stateDirectory(env), "package");
}

export function themePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(packageDirectory(env), "theme.json");
}

export function mergeTheme(theme: Theme, change: ThemeChange): Theme {
  return ThemeSchema.parse({
    ...theme,
    ...change,
    font: { ...theme.font, ...change.font },
    outline: { ...theme.outline, ...change.outline },
  });
}

/** The saved theme over the defaults; the defaults when no theme is saved. Throws on an invalid file. */
export async function loadTheme(path = themePath()): Promise<Theme> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_THEME;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const change = ThemeChangeSchema.safeParse(parsed);
  if (!change.success) throw new Error(`${path} is not a valid theme: ${change.error.issues.map(({ path: at, message }) => `${at.join(".")}: ${message}`).join("; ")}`);
  return mergeTheme(DEFAULT_THEME, change.data);
}

export async function saveTheme(theme: Theme, path = themePath()): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(theme, null, 2)}\n`);
}

/** #RRGGBB or #AARRGGBB as [alpha, red, green, blue]. */
function channels(hex: string): [number, number, number, number] {
  const digits = hex.slice(1);
  const value = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16);
  return digits.length === 8 ? [value(0), value(2), value(4), value(6)] : [255, value(0), value(2), value(4)];
}

/** OBS's FreeType text colors are 0xAABBGGRR. */
export function toAbgr(hex: string): number {
  const [a, r, g, b] = channels(hex);
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** OBS's GDI+ text colors are 0xBBGGRR with a separate opacity. */
function toBgr(hex: string): { color: number; opacity: number } {
  const [a, r, g, b] = channels(hex);
  return { color: (b << 16) | (g << 8) | r, opacity: Math.round((a / 255) * 100) };
}

export const WINDOWS_TEXT_KIND = "text_gdiplus_v3";
export const FREETYPE_TEXT_KIND = "text_ft2_source_v2";
export const TEXT_KINDS = new Set([WINDOWS_TEXT_KIND, FREETYPE_TEXT_KIND]);

/** OBS's text source for the platform it runs on: GDI+ on Windows, FreeType elsewhere. */
export function textInputKind(platform: string | undefined): string {
  return platform === "windows" ? WINDOWS_TEXT_KIND : FREETYPE_TEXT_KIND;
}

/** Text source settings in the theme's style, sized for the canvas height. */
export function textSettings(kind: string, text: string, theme: Theme, canvasHeight = 1080): JsonObject {
  const style = theme.font.style.toLowerCase();
  const flags = (style.includes("bold") ? 1 : 0) | (style.includes("italic") ? 2 : 0);
  const font = {
    face: theme.font.face,
    size: Math.max(8, Math.round(theme.font.size * (canvasHeight / 1080))),
    style: theme.font.style,
    flags,
  };
  if (kind === WINDOWS_TEXT_KIND) {
    const fill = toBgr(theme.textColor);
    const outline = toBgr(theme.outline.color);
    return {
      text,
      font,
      color: fill.color,
      opacity: fill.opacity,
      outline: theme.outline.enabled,
      outline_size: theme.outline.size,
      outline_color: outline.color,
      outline_opacity: outline.opacity,
    };
  }
  const fill = toAbgr(theme.textColor);
  return { text, font, color1: fill, color2: fill, outline: theme.outline.enabled, drop_shadow: theme.shadow };
}

export const POSITIONS = [
  "top-left", "top", "top-right",
  "left", "center", "right",
  "bottom-left", "bottom", "bottom-right",
  "lower-third", "full",
] as const;

export type Position = typeof POSITIONS[number];

// OBS alignment flags: an item's position is the point of it these name; 0 is its center.
const LEFT = 1;
const RIGHT = 2;
const TOP = 4;
const BOTTOM = 8;

/** A lower third sits this far up from the bottom edge, as a share of the canvas height. */
const LOWER_THIRD_FROM_BOTTOM = 0.15;

/**
 * The scene item transform that places an item at a named position inside
 * the title-safe margin. "full" scales the item to fit inside the margin.
 */
export function positionTransform(position: Position, canvas: { width: number; height: number }, marginPercent: number): JsonObject {
  const marginX = Math.round(canvas.width * marginPercent / 100);
  const marginY = Math.round(canvas.height * marginPercent / 100);
  const xs = { left: marginX, center: Math.round(canvas.width / 2), right: canvas.width - marginX };
  const ys = { top: marginY, middle: Math.round(canvas.height / 2), bottom: canvas.height - marginY };
  const place = (x: keyof typeof xs, y: keyof typeof ys) => ({
    alignment: (x === "left" ? LEFT : x === "right" ? RIGHT : 0) | (y === "top" ? TOP : y === "bottom" ? BOTTOM : 0),
    positionX: xs[x],
    positionY: ys[y],
  });
  const unbounded = { boundsType: "OBS_BOUNDS_NONE", scaleX: 1, scaleY: 1, rotation: 0 };
  switch (position) {
    case "top-left": return { ...unbounded, ...place("left", "top") };
    case "top": return { ...unbounded, ...place("center", "top") };
    case "top-right": return { ...unbounded, ...place("right", "top") };
    case "left": return { ...unbounded, ...place("left", "middle") };
    case "center": return { ...unbounded, ...place("center", "middle") };
    case "right": return { ...unbounded, ...place("right", "middle") };
    case "bottom-left": return { ...unbounded, ...place("left", "bottom") };
    case "bottom": return { ...unbounded, ...place("center", "bottom") };
    case "bottom-right": return { ...unbounded, ...place("right", "bottom") };
    case "lower-third":
      return { ...unbounded, alignment: LEFT | BOTTOM, positionX: marginX, positionY: Math.round(canvas.height * (1 - LOWER_THIRD_FROM_BOTTOM)) };
    case "full":
      return {
        rotation: 0,
        alignment: 0,
        positionX: xs.center,
        positionY: ys.middle,
        boundsType: "OBS_BOUNDS_SCALE_INNER",
        boundsAlignment: 0,
        boundsWidth: Math.max(1, canvas.width - 2 * marginX),
        boundsHeight: Math.max(1, canvas.height - 2 * marginY),
      };
  }
}

/** Full-canvas fit with no margin, for intro videos. */
export function fillTransform(canvas: { width: number; height: number }): JsonObject {
  return {
    rotation: 0,
    alignment: 5,
    positionX: 0,
    positionY: 0,
    boundsType: "OBS_BOUNDS_SCALE_INNER",
    boundsAlignment: 0,
    boundsWidth: canvas.width,
    boundsHeight: canvas.height,
  };
}

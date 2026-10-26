# On-screen graphics: user stories and design

Status: October 2026. Phase 1 (native titles, images, the theme, video clips, and intros) is built; see the README's Graphics section. Phases 2 and 3 are proposals.

"Packaging" is everything drawn on top of the picture: titles, lower thirds, "starting soon" cards, logos, intro and outro videos, and stinger transitions. A streamer wants to say "put *Day 3: building an OBS MCP* at the bottom" or "play my intro, then go to the main scene" and see it on screen, styled like the rest of the show.

## What the server can already do

Today an agent can do all of this one request at a time:

- **Text and images:** `obs-create-input` creates a text source (`text_ft2_source_v2` on macOS and Linux, `text_gdiplus_v3` on Windows), an image, a color source, a browser source, or a media source. `obs-set-input-settings` changes its text, font, color, or file.
- **Placement:** `obs-set-scene-item-transform` sets position, scale, and alignment; `obs-set-scene-item-enabled` shows and hides; `obs-set-scene-item-index` changes stacking order.
- **Video:** `obs-trigger-media-input-action` plays, restarts, and stops media sources, and OBS sends `MediaInputPlaybackEnded` when a video finishes.
- **Transitions:** scene transitions, per-scene overrides, and stinger settings.
- **Describing a scene:** `obs-apply-scene` builds a whole scene from a description.

What's missing is the layer a person thinks in. To add a title, the agent has to pick the right text source kind for the platform, guess font settings, work out pixel positions for "bottom left", remember to hide it later, and make it look like the last one. There is no animation: OBS WebSocket has no request for a scene item's show and hide transitions, so items pop on and off.

## User stories

Priority: **P1** first release, **P2** next, **P3** later.

### Titles and text

| ID | Story | P |
|---|---|---|
| T1 | "Add a title *X* at the bottom": it appears in my style, in a sensible place. | P1 |
| T2 | "Change the title to *Y*": the same graphic updates and isn't duplicated. | P1 |
| T3 | "Show it for 10 seconds" or "hide the title". | P1 |
| T4 | Say where in words: bottom left, top center, lower third, full screen. Margins keep it inside the safe area. | P1 |
| T5 | "Show my guest: *Ana Lima, designer at Acme*" as a two-line name and role lower third. | P2 |
| T6 | Titles animate in and out instead of popping. | P2 |
| T7 | A scrolling ticker, rotating social handles, or a "now playing" line. | P3 |

### Cards and scenes

| ID | Story | P |
|---|---|---|
| C1 | "Starting soon" with a countdown that ends on time. | P2 |
| C2 | "Be right back" and "ending" cards with the current title and my handles. | P2 |

### Video

| ID | Story | P |
|---|---|---|
| V1 | "Play my intro, then go to the main scene." | P1 |
| V2 | "Play *airhorn.mp4* over the stream": it plays once, on top, then disappears. | P1 |
| V3 | Use my stinger video for scene changes, cut at the right moment. | P2 |
| V4 | Loop a background video behind a card. | P2 |

### The package itself

| ID | Story | P |
|---|---|---|
| K1 | One theme (fonts, colors, logo, corner radius) that every graphic uses, so the show looks consistent. | P1 |
| K2 | See a graphic before viewers do (studio mode preview, or a screenshot). | P2 |
| K3 | Keep the package as files in a folder, so I can version it and share it. | P2 |
| K4 | Graphics never cover my face cam or another graphic. | P3 |

## Two ways to draw graphics

**Native OBS sources** (text, image, media) need nothing extra and work everywhere. Their limits: no animation, text styling limited to font, color, outline, and shadow, and the two text source kinds take different settings.

**Browser source templates** are HTML and CSS pages that OBS renders. They can animate, use any web font, and lay out two-line lower thirds properly. Their limits: each one is a Chromium page, using some GPU and memory, and they need a page to load.

**Recommendation:** use both, behind the same tools.

- P1 uses native sources, so titles work on day one with nothing to set up.
- P2 adds templates for animated graphics. OBS MCP serves the template pages from its own local HTTP server (it already has an HTTP mode). Each graphic slot is one browser source pointing at `http://127.0.0.1:<port>/graphics/<slot>`. The page keeps a server-sent events connection open, and the server pushes new text and "animate in" or "animate out" to it. Changing a title then sends one message instead of rebuilding or reloading a source, and the animation plays in the page.
- For native sources that should fade, there is a fallback: a Color Correction filter's opacity stepped from 0 to 100 through `obs-batch` in per-frame mode (`SerialFrame`), so each step lands on its own frame.

## Proposed tools

A new `graphics` tool group.

| Tool | Stories | What it does |
|---|---|---|
| `obs-graphic-show` | T1–T6, C1, C2 | Shows a graphic in a named slot: `{ slot: "title", template: "lower-third", fields: { title, subtitle }, position: "bottom-left", seconds?: 10, scene? }`. Creates the source the first time, updates it after that, and hides it when `seconds` run out. Returns a screenshot. |
| `obs-graphic-hide` | T3 | Hides a slot (animated when its template supports it). |
| `obs-graphic-list` | T2 | Lists slots, their scene, current text, and whether they're showing. |
| `obs-play-video` | V2, V4 | Plays a file over the program scene once (or looping), on top, and removes it when `MediaInputPlaybackEnded` arrives. |
| `obs-play-intro` | V1 | Plays a video full screen in its own scene, then switches to the target scene when it ends. |
| `obs-set-stinger` | V3 | Sets up a stinger transition from a video file, with the cut point read from the file's length unless one is given. |
| `obs-package-theme` | K1, K3 | Reads or sets the theme: fonts, colors, logo, margins. Stored as `package/theme.json` next to the templates. |
| `obs-graphic-preview` | K2 | Builds the graphic in the preview scene in studio mode, or returns a screenshot without showing it. |

`position` takes words, not pixels: `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right`, `lower-third`, and `full`. They map to OBS alignment plus a margin of 5% of the canvas (the title-safe area), using the canvas size from `GetVideoSettings`, so the same command works at 720p and 4K.

## The package folder

```text
package/
  theme.json            fonts, colors, logo, margins
  templates/
    lower-third.html    two lines, slides in from the left
    title-card.html     full screen, with an optional countdown
    ticker.html
  media/
    intro.mp4
    stinger.webm
```

The server ships a default package and reads one from `OBS_MCP_PACKAGE_DIR` when it's set. Templates are plain HTML that receive `fields` and `theme`, so a designer can change them without touching the server.

## Things to get right

- **One graphic per slot.** Track slots by name in the server's state directory and reuse the same input, so "change the title" never stacks a second one. Existing inputs are found by name, as `obs-apply-scene` does.
- **Stacking order.** A new graphic goes above the camera and screen capture, below any existing topmost graphic.
- **Readability.** After showing a graphic, take a screenshot and check it isn't 0×0 and is inside the canvas. `obs-audit-scene` can later warn when a graphic overlaps a face cam (K4).
- **Timers.** Like take deadlines, `seconds` needs the server running; if it restarts, the next `obs-graphic-list` shows the graphic still visible.
- **Text source differences.** Hide the macOS/Linux and Windows text settings behind one style taken from the theme.
- **Local server only.** The template server listens on 127.0.0.1, as the HTTP mode does. A page can only receive text and theme values; it never runs commands.
- **Undo.** Snapshot before changing an existing scene, so `obs-restore` can undo a graphic.

## Rollout

1. **P1, native:** slots, `obs-graphic-show`, `-hide`, and `-list` with native text and images, position words, the theme file, `obs-play-video`, and `obs-play-intro`. Tests use the existing fake OBS server, including `MediaInputPlaybackEnded`.
2. **P2, templates:** the local template server with server-sent events, the default package (lower third, title card with countdown, be right back), animated in and out, `obs-set-stinger`, and preview.
3. **P3:** ticker and rotating text, overlap checks, and importing and exporting packages.

## Open questions

- Which looks should the default package ship? A neutral one is safest; you may already have a brand or a designer's files to start from.
- Should graphics live in the scene that's live, or in a shared "Overlays" scene nested into every scene? A nested scene keeps a title visible across scene switches, which most streamers expect.

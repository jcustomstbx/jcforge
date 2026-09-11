# Handoff: JCForge — AI stream clip capture for Windows

## Overview

JCForge is a Windows desktop application for a solo Twitch streamer running OBS.
While the stream is live it scores three signals — microphone level, chat
velocity, and on-screen motion — into a single "excitement" value. When that
value crosses a threshold it instructs OBS to save its replay buffer, producing a
full-quality local clip (1440p120) starting twelve seconds *before* the trigger.
Clips land in a folder on the user's own drive. A built-in editor trims, reframes
to 9:16, captions locally with Whisper, and renders a finished vertical file.
The user uploads it themselves — there is no publishing API in v1.

The design covers seven screens in one window with a left navigation rail
grouped Capture / Produce / Setup.

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes
showing intended look and behaviour. They are **not production code to copy**.

`JCForge v2.dc.html` is a single-file React-based prototype using a small
in-house runtime ("Design Components"). All styling is inline. All data is
hardcoded. Nothing in it connects to OBS, records video, or detects anything.
Treat it as a very precise visual specification you can open in a browser,
click through, and measure.

The task is to **recreate these designs in a real application**. No codebase
exists yet, so the recommended environment is below; if you prefer a different
stack, keep the visual spec and the OBS-owns-video architecture and change the
rest freely.

## Fidelity

**High-fidelity.** Colours, typography, spacing, radii and interaction states
are final and intended to be matched closely. Every hex value in this document
appears verbatim in the prototype. Layout proportions (panel widths, aspect
ratios) are deliberate and should be preserved.

Two exceptions that are deliberately *not* final:
- The clip editor exists in **two directions** behind an A/B toggle. Build one.
  Recommendation: **B · Step rail** for v1.
- All sample content (clip titles, scores, timestamps, "nyxwave", Tarkov) is
  placeholder data.

---

## Recommended stack

| Layer | Choice | Reason |
|---|---|---|
| Shell | Tauri 2 + React + TypeScript | Small .exe; Rust backend for audio/timing; the prototype is already React-shaped |
| Capture | `obs-websocket` v5 (obs-websocket-js) | OBS owns all video encoding. JCForge never touches NVENC |
| Audio signal | `cpal` on the mic device, or OBS input volume meters | Mic RMS in 100 ms windows |
| Motion signal | OBS `GetSourceScreenshot` at 2–4 fps, downscaled to ~64px wide | Mean absolute difference between consecutive frames |
| Chat signal | Twitch IRC over websocket (anonymous read) | Message rate + emote density |
| Trim & render | FFmpeg bundled as a sidecar | Trim, crop to 9:16, burn captions, H.264 out |
| Captions | whisper.cpp sidecar | Runs on the finished clip only, never live |
| Storage | SQLite for metadata and score history | Video files stay where OBS wrote them |

**The load-bearing architectural decision: OBS owns video.** The app sends OBS
instructions and reads its state. It does not capture frames, encode, or manage
a buffer itself. Do not replace this with a custom capture engine.

### Key OBS WebSocket calls

- `GetVersion` / `GetStats` — connection check, dropped frames
- `StartReplayBuffer` / `StopReplayBuffer` / `GetReplayBufferStatus`
- `SaveReplayBuffer` — fires on a detected moment
- `ReplayBufferSaved` event — returns `savedReplayPath`; this is the clip
- `GetSourceScreenshot` — motion sampling (`imageFormat: "jpg"`,
  `imageWidth: 64`, low quality)
- `GetInputVolumeMeters` / `InputVolumeMeters` event — mic level, if not using cpal
- `GetCurrentProgramScene` / `CurrentProgramSceneChanged` — suppress motion
  detection across scene transitions

---

## Detection model

Each signal is normalised 0–1 against **its own rolling baseline for the
session**, then weighted and summed into a composite score. Baseline
normalisation is important: a quiet streamer's raised voice must score the same
as a loud streamer's.

| Signal | Source | Default weight |
|---|---|---|
| Raised voice | Mic RMS peak above rolling baseline, 100 ms windows | 0.85 |
| Chat spike | Messages/sec + emote density, Twitch IRC | 0.70 |
| Screen motion | Frame delta on downscaled OBS screenshots, 2–4 fps | 0.55 |

Clip shape, all user-adjustable in the Detection screen:

- Pre-roll **12 s** — how far back from the trigger the clip starts
- Post-roll **6 s** — how long after the score falls the clip continues
- Max length **60 s**
- Cooldown **45 s** — prevents one long fight becoming nine clips
- Threshold **0.72** composite

Presets are weight bundles: **Balanced** (default, shown active), **Hype only**,
**Comedy**, **Chat-led**.

Rules that matter:
- Nothing is auto-published and nothing is deleted. Detection *proposes*; the
  user keeps or skips.
- A skipped proposal still logs its score — that history feeds the backtest.
- Backtest re-runs current weights against the last recorded session and reports
  clips proposed / kept / precision.

### Known risks

- The replay buffer must be enabled in OBS with enough memory for 120 s at
  1440p120 — several GB of RAM. Check at startup and warn.
- Repeated screenshot requests add load to OBS. Test sample rate on a mid-range
  GPU with a game running.
- Motion detection will false-fire on camera shake and scene transitions. Expect
  to tune this signal hardest.
- `SaveReplayBuffer` saves the last N seconds as configured in OBS, so pre-roll
  is bounded by buffer length, not by user preference.

---

## Design tokens

### Colours

| Token | Hex | Use |
|---|---|---|
| Page background | `#0a0b0e` | App backdrop outside the window frame |
| Window body | `#101216` | Main window fill |
| Title bar | `#15181d` | Top chrome strip |
| Nav rail | `#0d0f13` | Left rail |
| Panel | `#14171c` | All cards and panels |
| Panel raised | `#181c22` | Clip cards in the live feed |
| Inset / control | `#191d24` | Buttons, rows, list items |
| Well | `#0c0e12` | Graph and waveform backgrounds |
| Video well | `#07080a` / `#0a0c0f` | Preview areas |
| Hairline | `#23262e` | Standard border |
| Hairline dim | `#21242c` | Internal dividers |
| Border control | `#2b303a` | Button and input borders |
| Track | `#1e2229` | Slider and meter tracks |
| Accent | `#3ddbc6` | State, selection, confirmation, primary action |
| Accent deep | `#1d8f9e` | Gradient partner, slider knob ring |
| Accent border | `#2b6f66` | Selected panel border |
| Accent tint | `rgba(61,219,198,.12)` | Selected chip fill |
| Accent on-dark text | `#062024` | Text on accent buttons |
| Alert | `#ffb340` | A detected moment, and nothing else |
| Alert text | `#ffd39b` | Text on alert surfaces |
| Alert tint | `rgba(255,179,64,.14)` | Alert badge fill |
| Live / record | `#ff4d4d` | REC indicator, stop button |
| Text primary | `#e7e9ee` | Body |
| Text bright | `#eafffb` | Active nav item |
| Text secondary | `#c9ced8` / `#aeb5c0` | Labels, values |
| Text muted | `#8b93a1` / `#7c8391` | Section headers, captions |
| Text dim | `#6d7380` | Monospace readouts |
| Text faint | `#575d69` / `#4a5260` / `#3c4450` | Nav group labels, placeholders |
| Brand Twitch | `#9146ff` | Source card dot |
| Brand OBS | `#302e3b` | Source card dot |

**The one inviolable rule: amber `#ffb340` means a moment was detected.** If
amber is used for anything else, the peripheral-vision reading of the OBS dock
stops working.

### Typography

- **UI:** Barlow — 400 / 500 / 600 / 700
- **All numerals, timecodes, file paths, technical readouts:** IBM Plex Mono — 400 / 500 / 600

| Role | Size | Weight | Notes |
|---|---|---|---|
| Screen title (h1) | 19px | 600 | `letter-spacing: -.01em` |
| Screen subtitle | 12.5px | 400 | `#7c8391` |
| Section header | 11px | 600 | `letter-spacing: .1em`, uppercase, `#8b93a1` |
| Nav group label | 10px | 600 | `letter-spacing: .12em`, uppercase, `#575d69` |
| Nav item | 13px | 500 | |
| Card title | 12.5–13px | 600 | |
| Body / label | 11.5–12.5px | 400–500 | |
| Meter readout | 11px | 400 | mono, `#6d7380` |
| Score badge | 10.5–12px | 700 | mono |
| Big stat | 14–15px | 600 | mono |
| Title bar app name | 12.5px | 600 | `letter-spacing: .04em` |
| Burned-in caption (9:16 preview) | 20–21px | 700 | `line-height: 1.25`, white on `rgba(8,10,13,.72)` |

### Spacing, radii, effects

- Window padding 20px; panel padding 12–15px; control padding 5–9px vertical
- Gaps: 6px (tight control rows), 9–10px (card stacks), 12–14px (panels), 18–20px (columns)
- Radii: **3px** tags · **4px** small controls/badges · **5px** buttons and inputs · **6px** wells and nav items · **7–8px** panels and cards · **10px** window
- Active nav item: `background:#1c2a2b; color:#eafffb; box-shadow: inset 2px 0 0 #3ddbc6`
- Window shadow: `0 30px 80px rgba(0,0,0,.6)`
- Hover on bordered controls: border becomes `#3ddbc6`
- Hover on nav items: `background:#1a1e25; color:#e7e9ee`, transition `background .12s`
- Alert glow on timeline marks: `box-shadow: 0 0 8px rgba(255,179,64,.6)`
- Scrollbars: 10px, thumb `#2a2d36`, radius 6px, transparent track

### Animations

Only two, both in the prototype's `@keyframes`:

- `pulseDot` — opacity 1 → .25 → 1. Used on live/alert dots.
  Durations: 1.1s (excitement badge), 1.2s (dock alert), 1.6s (REC indicator)
- `riseIn` — `opacity 0, translateY(8px)` → rest, **.25s ease both**.
  Used when a new clip card appears in the live feed. This is the only entrance
  animation in the app and it should stay that way.

---

## Screens

All seven live in one window: a 40px title bar across the top, a **196px** fixed
left nav rail, and a content area.

### Title bar

Left: 16px rounded-square logo (`linear-gradient(140deg,#3ddbc6,#1d8f9e)`),
app name, then mono meta text (`dock v0.9 · attached to OBS 30.2`). Right: a
live pill — `#1d2129` fill, `#2b303a` border, pulsing `#ff4d4d` 6px dot,
mono `LIVE 2:14:07` — then window controls.

### Navigation rail

Three groups with uppercase labels:

- **CAPTURE** — Live session (badge `REC`), Sources, OBS dock
- **PRODUCE** — Clip library (badge `42`), Clip editor
- **SETUP** — Detection, Recording

Each item: mono glyph in a 14px column (`#5f97a0`), label, then an optional
right-aligned badge (10px mono, `rgba(61,219,198,.14)` fill, `#3ddbc6` text).

Rail footer, above a hairline: "SSD buffer / 41%" with a 4px accent progress
bar and the line "18 min of 1440p120 headroom". **Express disk space as
recording minutes, not gigabytes** — it is the number the user actually needs.

---

### 1. Live session

**Purpose:** the during-stream view on the main monitor.

Header: title, then mono context (`twitch.tv/nyxwave · Escape from Tarkov ·
4,182 viewers`), then two buttons right-aligned — "Mark manually (F9)"
(outlined) and "Stop capture" (`#ff4d4d` fill, `#1a0505` text).

Body is two columns: flexible left, **314px** fixed right.

**Left column, top — ingest preview.** 16:9, `radial-gradient(120% 90% at 30%
20%, #1c2a33 0%, #0b0d11 70%)`. Centre placeholder reads `INGEST PREVIEW` /
`2560×1440 · 120 fps · NVENC AV1`. Top-left overlays: a red `REC` pill and a
`buffer 120s` pill. Bottom-right: the live excitement badge — amber-tinted,
pulsing dot, "Excitement rising — 0.81".

**Left column, bottom — excitement timeline.** Header "EXCITEMENT TIMELINE" with
mono "last 30 min · threshold 0.72" right-aligned. An 86px well containing:
a dashed `#4a5260` horizontal threshold line at 28% from top; an SVG area
chart (`#3ddbc6` 1px polyline, gradient fill `#3ddbc6` .45 → 0 top to bottom,
`preserveAspectRatio: none`); and vertical amber moment marks (2px wide, full
height, glow). Below the well, three signal meters in a wrapping row — label
left, mono value right, 5px track with a 3px-radius fill. **Fill is amber when
the signal is above ~0.8, accent otherwise.**

**Right column — "CAUGHT THIS SESSION".** Header with mono "7 new" in accent.
Scrolling stack of clip cards, each: a 76×44 thumbnail showing its timecode in
mono, title, reason text, and a bold mono score. Below, three buttons —
**Keep** (accent-tinted `#1f2a2a` / `#3ddbc6`), **Discard** (neutral), **Edit**
(outlined, navigates to the editor). Cards scoring high get an
`rgba(255,179,64,.35)` border and an `#ffd39b` score. New cards enter with
`riseIn`.

### 2. OBS dock

**Purpose:** the interface actually used mid-stream, docked inside OBS. This is
the most important screen to get right — it is where the product succeeds or
fails.

A **300px** panel. Its own mini title bar (`#1a1d22`, 12px logo, name, ⋮). Then,
in order:

1. Alert row — amber tint fill, `rgba(255,179,64,.35)` border, pulsing dot,
   "Moment detected", mono score right-aligned
2. Two buttons side by side — **Keep** (accent fill, dark text, 700) and
   **Skip** (neutral)
3. A 44px waveform well
4. Three compact meters (Voice / Motion / Chat), 10.5px labels, 4px tracks
5. Footer above a hairline: mono "7 kept · 2 skipped" and "F9 mark" in accent

Design constraints: one proposal at a time, no lists, no scrolling, nothing that
requires reading a sentence.

### 3. Sources

**Purpose:** connection state and where clips go. Max width 900px.

Intro: "JCForge drives OBS's replay buffer to save clips at full quality,
straight to your own drive. Twitch chat is optional context for detection."

Two cards in a 1fr 1fr grid:
- **Twitch** — `#9146ff` dot, `CONNECTED` badge, "nyxwave", mono
  "chat + viewer metrics + stream key". Border `#2b6f66` when connected.
- **OBS WebSocket** — `#302e3b` dot, `CONNECTED` badge, "localhost:4455 ·
  OBS 30.2", mono "replay buffer · scene state · mic levels".

Then **WHERE CLIPS GO** — two read-only mono fields: "Clips folder"
(`D:\\JCForge\\clips`) and "Free space" ("738 GB · 18 min headroom at
1440p120"). Fields are `#0d0f13` on `#2b303a` borders.

Then an OBS dock install row: "OBS Studio detected" / "The dock is the whole
interface while you play. Keep or skip, nothing else." with an accent
"Install dock" button that navigates to the dock screen.

### 4. Clip library

**Purpose:** review everything caught.

Header: title, "138 clips · 42 unreviewed", then filter chips right-aligned —
**All** (active), Unreviewed, Score > 0.8, Rendered. Active chip:
`rgba(61,219,198,.12)` fill, `#3ddbc6` border and text.

Grid: `repeat(auto-fill, minmax(228px, 1fr))`, 12px gap, scrolling. Each card
has a 16:9 thumbnail (`linear-gradient(145deg,#1b2430,#0b0d11)`) with duration
top-left, score badge top-right (amber variant when high-scoring), and signal
tags bottom-left. Below: title, mono meta (`1440p120 · today 21:14`), then
**Open editor** (accent-tinted, full width) and a `⋯` overflow button.
Card hover: border → `#3a4150`.

### 5. Clip editor — build ONE of two

Header: title, mono file context (`tarkov_2h14m_ambush.mkv · 00:58 · 1440p120`),
then the A/B segmented toggle. **The toggle is a design-review device — remove
it in the real app.**

#### B · Step rail — RECOMMENDED FOR V1

Left: preview area containing the 9:16 output (max-height 430px, radial
gradient, burned caption near the bottom) and a 132px "ALT CUTS" column of three
9:16 thumbnails (wide / face / split; selected one has an accent border).
Below the preview, a compact scrub bar: mono `00:00`, a 26px track with the
accent-bordered selection region and the amber peak line, mono `00:58`.

Right: a **348px** rail of four accordion steps, one open at a time. Each step
header: a 22px numbered circle (accent fill + dark text when open, `#232830` +
`#8b93a1` when closed), title, summary line, and a mono tag. Open step border
is `#2b6f66`. Contents are label/value rows (`#191d24` on `#24282f`, value in
accent mono).

| # | Step | Summary | Rows |
|---|---|---|---|
| 1 | Framing | Subject-tracked 9:16, crosshair locked | Mode: Track subject · Safe margins: TikTok + Shorts · Zoom: 1.18× |
| 2 | Captions | 14 lines · Whisper large-v3 | Style: Impact pop · Profanity: Kept · Language: English |
| 3 | Audio | Mic +3 dB, game ducked | Mic gain: +3.0 dB · Game duck: -6 dB · Loudness: -14 LUFS |
| 4 | Export | 1080×1920 · 60 fps · saved locally | Container: MP4 / H.264 · Frame rate: 60 fps · Destination: renders folder |

Below the rail: a full-width accent button, "Render to folder".

#### A · Timeline — alternative

Three columns over a full-width timeline.

- **Left, 210px — SOURCE FRAME.** A 16:9 source thumbnail with the 9:16 crop
  box drawn as a 2px accent rectangle (38% wide, inset 6% top and bottom) using
  `box-shadow: 0 0 0 9999px rgba(6,8,10,.62)` to dim everything outside it.
  Explanatory line, then three framing options as selectable rows: Track subject
  (default, active), Static centre (safe), Split · cam + game (beta).
- **Centre — 9:16 output preview,** max-height 460px, on a `#0a0c0f` well.
  Contains: centre placeholder `9:16 OUTPUT`; the burned caption 74px from the
  bottom (21px/700 white with the accent-coloured second half, on a
  `rgba(8,10,13,.72)` box drawn with `box-shadow: 0 0 0 7px`); an `@nyxwave`
  watermark top-left; a playback progress bar at the bottom.
- **Right, 262px —** CAPTIONS (four editable timecoded lines, active line
  accent-bordered), AUDIO (three sliders: Mic gain +3.0 dB, Game duck -6 dB,
  Music bed off — 4px track, accent fill, 13px `#eafffb` knob with a 2px
  `#1d8f9e` ring), EXPORT (aspect chips 9:16 / 1:1 / 16:9, mono render summary
  ending `→ D:\\JCForge\\renders`, accent "Render to folder" button).
- **Bottom, full width — TIMELINE.** Header with mono in/out timecodes and two
  chips, "Snap to peak" and "Trim silence". A 66px well containing a waveform
  strip in the top 26px (1px-gap bars, accent inside the selection, `#39404c`
  outside), the selection region below it (accent tint, 7px accent drag handles
  left and right), and the amber peak playhead with a `PEAK` flag tab at top.

### 6. Detection

**Purpose:** tuning. Two columns: content (max 720px) and a 300px backtest panel.

Intro: "Weights decide what counts as a moment. The composite score must cross
the threshold for a clip to be proposed."

Preset chips, then a panel of three weight sliders — each with label, a
plain-language note, mono value in accent, and a 5px track with knob. Then
**CLIP SHAPE** as a `repeat(auto-fit, minmax(150px, 1fr))` grid of four stat
tiles: Pre-roll 12 s · Post-roll 6 s · Max length 60 s · Cooldown 45 s.

Right panel — **BACKTEST · LAST STREAM**: "With these weights on your 4h 12m
Tarkov session:", then three rows — Clips proposed 31, You kept 24, Precision
77% — and a "Re-run backtest" button.

### 7. Recording

**Purpose:** quality settings, most of which JCForge writes into OBS rather than
owning itself. Max width 900px.

Intro: "JCForge sets OBS's replay buffer for you. The last two minutes are
always in memory, so a clip never starts late."

Four option cards in `repeat(auto-fit, minmax(200px, 1fr))`, each a group of
selectable rows with a mono hint on the right:

| Group | Options (active first) |
|---|---|
| RESOLUTION | 2560 × 1440 (native) · 1920 × 1080 (lighter) · 3840 × 2160 (heavy) |
| FRAME RATE | 120 fps (slow-mo ready) · 60 fps (standard) · 90 fps (balanced) |
| ENCODER | NVENC AV1 (RTX 40+) · NVENC H.265 (compatible) · x264 CPU (fallback) |
| BUFFER | 120 s rolling (recommended) · 60 s rolling (less disk) · Full session (archival) |

Then **DISK & ENCODER** with mono "OBS replay buffer · NVENC AV1 · GPU 22%"
right-aligned, a segmented 8px stacked bar (accent 28% clips, amber 13% buffer,
`#4a5260` 9% renders), and a legend: Clips 412 GB · Buffer 190 GB · Renders
128 GB · Free 738 GB.

---

## Interactions & behaviour

Implemented in the prototype:
- Nav rail switches screens; active item gets the inset accent bar
- "Edit" on a live clip card and "Open editor" on a library card navigate to the editor
- "Install dock" navigates to the OBS dock screen
- The editor A/B toggle switches editor direction
- Step rail steps open and close (clicking the open step collapses it)
- Hover states on every nav item, button, chip and selectable row

Needed in the real app but only *shown* as static state in the prototype:
- Live meters, waveform and timeline animating from real signal data
- New clip cards appearing (`riseIn`) as detections fire
- Keep / Discard / Skip actually resolving a proposal
- Trim handle and crop box dragging
- Caption line editing
- Slider dragging
- Render progress, and the states the prototype has no design for yet:
  **OBS disconnected**, **replay buffer disabled**, **disk nearly full**,
  **render failed**, **empty library**, **first run before any stream**

Those six missing states are real work. Design them as you build, following the
same panel/hairline/accent vocabulary.

## State management

Session-level: connection status (OBS, Twitch), live flag, elapsed time, stream
metadata, rolling baselines per signal, current composite score, score history
buffer for the graph, detection marks, cooldown timer.

Persisted (SQLite): clips (path, timecode in source, duration, composite score,
per-signal contributions, trigger reason, reviewed state, kept/skipped, render
outputs), sessions (start, end, game, clips proposed/kept), settings (weights,
preset, clip shape, recording config, folders).

Editor-local: in/out points, framing mode and crop rect, caption lines, audio
gains, export config.

## Assets

None. The prototype uses no images or icon libraries — glyphs in the nav rail
and buttons are Unicode characters (◉ ⇄ ▣ ▤ ✂ ∿ ⬤ ⋯ ⋮). **Replace these with a
real icon set** (Lucide or Phosphor) in the implementation; they were a
prototype expedient, not a design choice.

Fonts: Barlow and IBM Plex Mono, both Google Fonts — bundle them locally for a
desktop app rather than fetching at runtime.

All video previews are CSS gradient placeholders.

## Files

| File | What it is |
|---|---|
| `JCForge v2.dc.html` | The design prototype. Open in a browser and click through it. Read it for exact values. |
| `JCForge Pitch and Spec.dc.html` | Product pitch, scope, detection model, architecture, build order, open questions. Printable. |
| `doc-page.js` | Runtime needed by the pitch document only. Not part of the product. |

The prototypes need internet access on first load (fonts and the DC runtime).

## Build order

Each milestone is shippable alone. **Do not start detection until a clip reaches
the disk by hand.**

1. **Shell and OBS connection** — app opens, connects to OBS, shows live buffer state
2. **Manual clip, end to end** — F9 saves a clip; it appears in the library with metadata
3. **Voice signal** — mic level drives the meter and fires a clip above threshold
4. **Chat and motion signals** — composite score, cooldown, live excitement timeline
5. **OBS dock** — keep/skip works inside OBS during a real stream
6. **Editor: trim and reframe** — a 9:16 file renders to the folder via FFmpeg
7. **Captions** — Whisper transcribes, lines are editable, text burns in
8. **Tuning and backtest** — presets, sliders, backtest against a recorded session

Milestone 5 is the honest test of the product: if the dock catches good moments
during one real four-hour stream and the streamer keeps more than half of what it
proposes, the idea works. Everything after that is polish.

## Open questions for the owner

- Editor direction A or B (recommendation: B)
- Does the app manage OBS's replay buffer settings, or only read them and warn?
- Free with a paid tier, one-off licence, or open source with paid support?
- Should skipped proposals delete their video immediately to save disk?
- Is 120 fps worth the buffer memory when most shorts publish at 30 or 60?

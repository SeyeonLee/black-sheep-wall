# Black Sheep Wall

> **CerebralValley 3rd Annual NatSec Hackathon** — [Event Page](https://cerebralvalley.ai/e/3rd-annual-natsec-hackathon)

---

<!-- INTRO — fill in here -->

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture Overview](#architecture-overview)
- [The Map](#the-map)
- [ISR Units](#isr-units)
- [Autonomous Behaviors](#autonomous-behaviors)
- [Operator Controls](#operator-controls)
- [Patrol System](#patrol-system)
- [Threat Detection](#threat-detection)
- [GPS Jamming](#gps-jamming)
- [AIS Integration](#ais-integration)
- [Visual Intel (GPT-4o)](#visual-intel-gpt-4o)
- [Alert Feed](#alert-feed)
- [Sandbox / Deploy Mode](#sandbox--deploy-mode)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Configuration](#configuration)
- [Tech Stack](#tech-stack)

---

## Quick Start

**Prerequisites:** Node.js 18+

```bash
# Clone and install
git clone <repo-url>
cd black-sheep-wall
npm install

# Start development server
npm run dev
# → http://localhost:5173

# Production build
npm run build
npm run preview
```

No environment variables or API keys are required to run the simulation. An OpenAI API key is only needed to use the [Visual Intel](#visual-intel-gpt-4o) panel. An AISHub username is only needed to overlay [real AIS data](#ais-integration).

---

## Architecture Overview

Black Sheep Wall is a **fully client-side** React + Vite single-page application. There is no backend — all simulation state lives in a single `useReducer` in `App.jsx`.

```
src/
├── config.js              # All tunable constants (speeds, ranges, thresholds)
├── utils.js               # Geo ↔ world coordinate math, AIS type decoder
├── App.jsx                # Root: reducer, ticks, AIS polling, keyboard shortcuts
├── sim/
│   ├── factories.js       # Unit constructors, synthetic AIS fleet generator
│   ├── reducer.js         # All state transitions (TICK, orders, deploy, patrols)
│   ├── tick.js            # Per-unit physics, detection logic, alert generation
│   ├── geometry.js        # Voronoi partitioning, polygon sweep-path planning
│   └── landData.js        # Natural Earth GeoJSON loader, isOnLand() collision
└── components/
    ├── MapView.jsx         # SVG map, camera, tile layers, all map interactions
    ├── TopBar.jsx          # Map style toggles, fog toggle, AIS, sim speed
    ├── AlertFeed.jsx       # Live alert panel
    ├── DockPanel.jsx       # Bottom panel chrome
    └── panels/
        ├── TacticalOverviewPanel.jsx  # Minimap
        ├── StatusPanel.jsx            # Force roster + selected unit detail
        ├── VisualIntelPanel.jsx       # GPT-4o image analysis
        └── CommandPanel.jsx           # Orders + deploy buttons
```

**Coordinate system:** A linear world projection of the Indo-Pacific (60°E–180°E, 20°S–70°N) onto a 6400×4000 world-pixel canvas. All simulation math runs in world-pixel space; geo coordinates are only used for tile placement and AIS display.

**Simulation loop:** A `setInterval` fires every 50 ms, dispatching a `TICK` action. The reducer runs every unit through `tickUnit()`, updates detections, stamps mine markers, handles auto-tracking, patrol interrupts, and generates alerts — all in a single synchronous pass.

---

## The Map

### Map Styles

Three styles are selectable from the **top bar**:

| Button | Style | Description |
|--------|-------|-------------|
| `TACT` | Tactical | Vector land polygons (Natural Earth 110m), ocean gradient, coordinate grid. Lowest latency — best for low-bandwidth or offline use. |
| `SAT` | Satellite | Esri World Imagery tiles. Shows real terrain and ocean floor. |
| `CHART` | Nautical | CARTO Voyager base tiles + OpenSeaMap seamark overlay. Shows shipping lanes, depth contours, and port markers. |

Click any style button in the top bar to switch instantly. Tile zoom level is automatically selected based on current camera zoom.

### Fog of War

Click **`FOG`** in the top bar to toggle fog of war on or off.

- When **on**, the map is darkened everywhere except within the sensor radius of active friendly units.
- When **off**, the full map is visible (useful for mission planning or sandbox debugging).
- Reveal radius is `FOG_REVEAL_RANGE` (default 260 world-px) per active friendly unit.

### Navigation

| Action | Result |
|--------|--------|
| **Scroll wheel** | Zoom in / out (min 0.12×, max 12×) |
| **Middle-click drag** or **Alt + left-drag** | Pan |
| **Edge pan** | Move cursor within 36 px of any map edge to auto-pan |

The camera is clamped — you cannot pan or zoom to empty space outside the world rectangle.

---

## ISR Units

Each **ISR unit** consists of three entities that move and act together:

```
ISR-n  (USV — Unmanned Surface Vessel)
  ├── α  (UAV — active, orbiting)
  └── β  (UAV — docked, charging)
```

### USV

The surface vessel. Navigates on water only (land-collision checked against Natural Earth polygons). Carries sonar for subsurface detection and an optical/RF sensor for surface/air detection.

| Property | Default |
|----------|---------|
| Speed | 0.45 world-px / tick |
| Sensor range | 180 world-px |
| Sonar range | 130 world-px |
| Battery drain | 0.008% / tick |
| Solar recharge rate | 0.04% / tick |
| Low-battery threshold | 40% → auto-charge state |

### UAV

Two UAVs per ISR unit rotate duty: one orbits the parent USV, the other docks and charges. When the orbiting UAV's battery drops below the low threshold it returns; the docked UAV auto-launches once fully charged.

| Property | Default |
|----------|---------|
| Speed | 2.2 world-px / tick |
| Sensor range | 240 world-px |
| Orbit radius (USV) | 90 world-px |
| Orbit radius (mission) | 60 world-px |
| Battery drain | 0.04% / tick |
| Charge rate | 0.18% / tick |
| Low-battery threshold | 28% |
| Return battery margin | +8% safety pad for proactive RTB |

UAVs ignore land collision. If battery math shows insufficient charge to return home, the UAV aborts its current mission proactively rather than running dry.

### UAV States

| State | Meaning |
|-------|---------|
| `DOCKED` | On USV, charging |
| `ORBITING` | Circling parent USV |
| `FLYING TO MISSION` | En route to assigned coordinate or target unit |
| `ON MISSION` | Orbiting assigned coordinate or target unit |
| `RETURNING` | RTB due to low battery or recall |
| `JAMMED` | GPS-denied; RTB autonomously |

---

## Autonomous Behaviors

These behaviors run every tick without operator input:

### UAV Duty Rotation

When the docked UAV reaches full charge **and** the orbiting sibling is not actively on a mission, the docked UAV auto-launches. This keeps one UAV airborne at all times.

### Auto-Track on New Detection

When a **submarine** or **hostile surface vessel** is detected for the first time (confidence crosses `POSSIBLE_THRESHOLD`), the nearest **idle** USV is automatically assigned to track it — unless the target is already being tracked by another friendly unit (USV or UAV). In that case, only an alert is raised.

### Patrol Interruption

A USV on patrol that brings an untracked hostile contact into sensor range will abort its patrol sweep and begin tracking the contact. The patrol area is automatically re-partitioned among the remaining patrol units (see [Patrol System](#patrol-system)).

### Mine Marking

When sonar detection confidence for a mine crosses `POSSIBLE_THRESHOLD`, a persistent **⚠ MINE** marker is stamped at the mine's world position. The marker survives even if the mine drifts out of sonar range and its confidence decays.

---

## Operator Controls

### Selecting Units

| Action | Result |
|--------|--------|
| **Left-click** a friendly USV | Select USV + its two attached UAVs |
| **Left-click** a friendly UAV | Select that UAV only |
| **Shift + left-click** | Add / remove unit from selection |
| **Left-drag** on empty map | Rubber-band box-select all friendly units inside |
| **Escape** | Clear selection |

### Issuing Orders

| Action | Selection | Result |
|--------|-----------|--------|
| **Right-click** water | USV selected | Move USV to that position |
| **Right-click** water | UAV selected | Fly to fixed-point mission; orbit on arrival |
| **Right-click** detected hostile / sub / merchant | USV selected | USV tracks target at standoff distance |
| **Right-click** detected hostile / sub / merchant | Airborne UAV selected | UAV flies to orbit target unit (follows as it moves) |
| **Right-click** a friendly unit (not in current selection) | USV or UAV | Escort: follow and circle the friendly unit |

### Command Panel Buttons

Located in the bottom-right **COMMAND** panel:

| Button | Shortcut | Action |
|--------|----------|--------|
| **MOVE** | — | Activates select/move tool (default mode) |
| **PATROL** | `P` | Draw a polygon patrol area for selected USVs |
| **HOLD** | `H` | Stop selected USVs in place; clear all orders |
| **RECALL** | — | Return selected UAVs from mission to parent USV |

### Status Panel

The **STATUS** panel (bottom bar, second from left) shows:
- **FORCE ROSTER** — all friendly units with current state and battery level. Click any row to select that unit.
- **SELECTED** — detail card for the selected USV: state, heading, battery, current track target.

---

## Patrol System

Patrol areas give USVs an autonomous coverage mission using lawnmower sweep paths.

### Drawing a Patrol Area

1. Select one or more USVs.
2. Press `P` (or click **PATROL** in the Command panel).
3. **Left-click** at least 3 vertices on the map to define the polygon boundary.
4. **Right-click** to close the polygon and commit.

The polygon outline renders in phosphor green with a hatch fill. Each USV's individual sweep lane is shown as a dashed line in a distinct color.

### Multi-Unit Patrol (Voronoi Partitioning)

When multiple USVs are assigned to one patrol area, the polygon is automatically divided into sub-regions using Voronoi decomposition. Each USV receives its own region and executes an independent lawnmower sweep inside it, maximizing total area coverage.

### Dynamic Re-partition

If a patrol unit is reassigned mid-mission (manually, by auto-tracking an intruder, or by patrol interruption), the remaining units automatically receive new, equally-sized sub-regions that together cover the full original polygon.

---

## Threat Detection

Detection is probabilistic — confidence builds over time when a sensor is in range and decays when the target leaves range.

### Sensor Coverage

| Sensor | Carried By | Detects |
|--------|-----------|---------|
| Optical / RF | USV + UAV | Surface vessels, other UAVs |
| Sonar | USV only | Submarines, mines |

UAVs have a larger optical sensor range (240 px) than USVs (180 px). Sonar range is 130 px.

### Detection Tiers

| Tier | Confidence | Visual on Map |
|------|------------|---------------|
| **Contact** | ≥ 5% | Unit appears with faint amber pulse ring, `NEW CNTCT` label |
| **Possible** | ≥ 35% | Dashed ring, `POSSIBLE` label; alerts generated; auto-track triggered |
| **Confirmed** | ≥ 75% | Full icon, `CONFIRMED` label |

Units tracked by a friendly USV or UAV display an amber pulsing ring (`AUTO-TRK`). Units being escorted by another friendly display a phosphor pulsing ring (`ESCORTED`).

### Auto-Track Suppression

Once any friendly unit (USV or UAV) is already tracking a target, additional contacts skip auto-assignment and only generate alerts. Manual override is always available via right-click.

### Mine Markers

When a mine crosses the **Possible** threshold, a persistent stamped marker (orange dashed circle + ⚠ label) appears at its position. To clear a mine:

> Click the **×** button on the marker → removes the marker **and** the mine unit from the simulation.

---

## GPS Jamming

### Placing a Jam Zone

1. In the **COMMAND** panel, click **+ JAM** to enter deploy mode.
2. Click anywhere on the map to place a jam zone (radius: 280 world-px).
3. The zone renders as a pulsing red circle.

### Removing a Jam Zone

**Shift + left-click** directly on the jam zone circle to remove it.

### Effects

| Unit | Behavior Inside Jam Zone |
|------|--------------------------|
| **UAV** | Immediately enters `JAMMED` state → RTB to parent USV autonomously |
| **USV** | Enters `JAMMED` state → repelled outward from zone center |

Any UAV on a mission when jammed has `missionAborted` set and generates a **GPS DENIAL** alert. Once clear of the zone (or once docked), the unit resumes normal behavior.

---

## AIS Integration

### Synthetic Fleet (always on)

64 vessels are simulated across 12 realistic Indo-Pacific shipping lanes (Singapore–Tokyo, Taiwan Strait, Manila–Guam, Japan Coast, and more), with accurate flag states, vessel types (CARGO, TANKER, CONTAINER, FISHING, PASSENGER), speeds, and destinations. They move continuously and are visible as teal triangle glyphs.

Right-clicking an AIS ship glyph while a USV is selected orders that USV to intercept and shadow the vessel.

### Real AIS via AISHub (optional)

To overlay live vessel positions from the real world:

1. Register for a free account at [aishub.net](https://www.aishub.net/).
2. Paste your **AISHub username** into the `AIS USER` field in the top bar.
3. Press **Enter** — the system fetches vessels within a 3°×3° bounding box around the nearest USV, refreshing every 60 seconds.
4. Real vessels are merged on top of the synthetic fleet (real MMSIs take precedence).

The indicator next to the field shows: `OK` · `FETCHING` · `ERROR` · `DISCONNECTED`.

---

## Visual Intel (GPT-4o)

The **VISUAL.INTEL** panel enables AI-powered vessel identification from aerial or satellite imagery.

### Requirements

- Exactly **one UAV** must be selected (the panel gates to a single active UAV).
- An **OpenAI API key** (`sk-...`) — entered once per session, stored in browser memory only, transmitted only to `api.openai.com`.

### Workflow

1. Select a single UAV on the map.
2. Open the **VISUAL.INTEL** panel (bottom bar, third from left).
3. Enter your OpenAI API key and press **Enter** or **CONNECT GPT-4o**.
4. **Drop an aerial image** onto the panel or click to browse. Any image format is accepted; images are automatically resized to 1024 px max and JPEG-compressed before upload.
5. Click **▶ ANALYZE WITH GPT-4o**.

### What GPT-4o Extracts

| Field | Description |
|-------|-------------|
| Company / Operator | Shipping company or operator if visible |
| Vessel Name | Hull text if legible |
| Vessel Type | TANKER · CARGO · BULK · CONTAINER · MILITARY · FISHING · PASSENGER · TUG |
| Estimated Length | Meters |
| Hull Color | Primary color |
| Flag | ISO country code |
| Visible Identifiers | Hull numbers, markings, pennant numbers |
| Confidence | 0–100% |
| Notes | Anomalies or observations (max 80 characters) |

### AIS Cross-Check

After analysis, the panel automatically cross-references the nearest AIS contact within the UAV's sensor envelope:

| Result | Meaning |
|--------|---------|
| **✓ AIS CONSISTENT** | CV fields match AIS data — no anomaly |
| **⚠ MISMATCH · N FIELDS** | Discrepancy in vessel type, flag, or class — suspicious |
| **⚠ AIS DARK — NO TRANSPONDER** | Vessel confirmed visually but transmitting no AIS signal |
| **// NO AIS CONTACT IN RANGE** | No AIS ship within UAV sensor range for comparison |

Mismatches and AIS-dark vessels automatically generate high-severity alerts in the Alert Feed. Click **RERUN** to re-analyze the same image; click **NEW IMG** to upload a different one.

---

## Alert Feed

The **ALERT FEED** panel (right side of map) collects all system events in reverse-chronological order. Up to 30 alerts are retained.

### Alert Types

| Kind | Severity | Trigger |
|------|----------|---------|
| `MINE` | Med / High | Mine detected at POSSIBLE / CONFIRMED threshold |
| `SUBSURFACE` | Med / High | Submarine detected at POSSIBLE / CONFIRMED threshold |
| `DETECT` | Med / High | Hostile surface vessel detected |
| `GPS.JAM` | Med (USV) / High (UAV) | Friendly unit enters GPS jam zone |
| `MISSION.ABORT` | Med | UAV returning due to insufficient battery for mission completion |
| `AIS.MISMATCH` | High | GPT-4o analysis contradicts AIS-reported fields |
| `AIS.DARK` | High | Vessel confirmed visually with no AIS signal |

Click **×** on any alert to dismiss it.

---

## Sandbox / Deploy Mode

The **DEPLOY** section of the Command panel lets you inject entities into the live simulation for testing and demonstration.

| Button | Entity | Notes |
|--------|--------|-------|
| **+ ISR** | New ISR unit (USV + 2 UAVs) | Placed at clicked position; immediately active |
| **+ MERCHANT** | Neutral commercial vessel | Wanders randomly; AIS-trackable by USVs |
| **+ HOSTILE** | Hostile surface vessel | Auto-detected by sensors; auto-tracked by idle USVs |
| **+ SUB** | Hostile submarine | Sonar-only detection; auto-tracked by idle USVs |
| **+ MINE** | Stationary mine | Sonar-detectable; placement on land is rejected |
| **+ JAM** | GPS jam zone | Affects all friendly units in radius |

Click a deploy button to enter deploy mode (cursor changes to `copy`), then click anywhere on the map to place the entity. The tool automatically returns to select mode after placement.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Pause / resume simulation |
| `Escape` | Deselect all / cancel current tool |
| `P` | Enter patrol-draw mode |
| `H` | Hold selected USVs (cancel all orders) |

Simulation speed (×1 / ×2 / ×4) is controlled by the speed buttons in the top bar.

---

## Configuration

All simulation parameters live in `src/config.js`. Key values to tune:

```js
// World bounds — Indo-Pacific linear projection
WORLD_W: 6400, WORLD_H: 4000
GEO_LON_MIN: 60,  GEO_LON_MAX: 180  // 60°E – 180°E
GEO_LAT_MIN: -20, GEO_LAT_MAX: 70   // 20°S – 70°N

// Unit speeds (world-px per tick at simSpeed=1)
USV_SPEED: 0.45
UAV_SPEED: 2.2
ENEMY_SPEED: 0.35
SUBMARINE_SPEED: 0.22

// Sensor ranges (world-px)
USV_SENSOR_RANGE: 180
UAV_SENSOR_RANGE: 240
SONAR_RANGE: 130
FOG_REVEAL_RANGE: 260

// Detection confidence thresholds (%)
CONTACT_THRESHOLD: 5      // unit first appears on map
POSSIBLE_THRESHOLD: 35    // alerts generated, auto-track triggered
CONFIRMED_THRESHOLD: 75   // confirmed status label

// Synthetic AIS fleet
AIS_VESSEL_COUNT: 64
AIS_TICK_MS: 1000         // fleet position update interval (ms)

// Simulation engine
TICK_MS: 50               // physics tick interval (ms)
JAM_ZONE_RADIUS: 280      // jam zone radius (world-px)
TRACK_STANDOFF: 90        // USV standoff distance from tracked target (world-px)
UAV_RETURN_BATTERY_MARGIN: 8  // % battery safety pad for proactive RTB
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + Vite 8 |
| Rendering | SVG (zero canvas, zero WebGL) |
| State | `useReducer` — single immutable state tree, no external library |
| Map tiles | Esri World Imagery · CARTO Voyager · OpenSeaMap |
| Land data | Natural Earth 110m GeoJSON (collision + tactical overlay) |
| AI | OpenAI GPT-4o (vision) |
| AIS | AISHub REST API (optional) · Synthetic fleet (built-in) |
| Icons | Lucide React |
| Fonts | JetBrains Mono · Chakra Petch |

---

## Team

<!-- Add team members here -->
- Seyeon Lee (https://www.linkedin.com/in/seyeonlee/)
- Jacob Nyhagen (https://www.linkedin.com/in/jacob-nyhagen-616b8427b/)
---

*Built for the [CerebralValley 3rd Annual NatSec Hackathon](https://cerebralvalley.ai/e/3rd-annual-natsec-hackathon)*

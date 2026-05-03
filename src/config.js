// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Map: Indo-Pacific / global view (60°E–180°E, 20°S–70°N)
export const CONFIG = {
  WORLD_W: 6400, WORLD_H: 4000,

  USV_SPEED: 0.45, UAV_SPEED: 2.2,
  ENEMY_SPEED: 0.35, COMMERCIAL_SPEED: 0.1,
  SUBMARINE_SPEED: 0.22,

  UAV_ORBIT_RADIUS: 90, UAV_ORBIT_ANGULAR_SPEED: 0.012,
  UAV_BATTERY_DRAIN: 0.04, UAV_CHARGE_RATE: 0.18,
  UAV_LOW_BATTERY: 28, UAV_FULL_BATTERY: 95, UAV_DOCK_RANGE: 8,
  UAV_MISSION_ORBIT_RADIUS: 60,
  UAV_RETURN_BATTERY_MARGIN: 8, // % safety pad for proactive abort

  USV_BATTERY_DRAIN: 0.008, USV_SOLAR_RATE: 0.04, USV_LOW_BATTERY: 40,

  USV_SENSOR_RANGE: 180, UAV_SENSOR_RANGE: 240, SONAR_RANGE: 130,
  FOG_REVEAL_RANGE: 260,

  CONFIDENCE_RATE: 0.9, CONFIDENCE_DECAY: 0.15,
  CONTACT_THRESHOLD: 5,    // first render/alert threshold
  POSSIBLE_THRESHOLD: 35,
  CONFIRMED_THRESHOLD: 75,
  MINE_DETECTION_BOOST: 1.4,

  TICK_MS: 50,
  EDGE_PAN_ZONE: 36, EDGE_PAN_SPEED: 16,

  JAM_ZONE_RADIUS: 280,
  PATROL_LANES: 6,
  TRACK_STANDOFF: 90,

  // Extended Indo-Pacific geo bounds: 60°E–180°E, 20°S–70°N
  GEO_LON_MIN:  60, GEO_LON_MAX: 180,
  GEO_LAT_MIN: -20, GEO_LAT_MAX:  70,

  // Synthetic AIS fleet
  AIS_TICK_MS: 1000,
  AIS_VESSEL_COUNT: 64,

  // Real AIS (AISHub) — optional
  AIS_RANGE_DEG: 3,
  AIS_FETCH_MS: 60000,
};

export const COLORS = {
  bg: "#08100c", surface: "#0d1612", surfaceHi: "#121e18",
  border: "#1f3329", borderHi: "#2d4a3c",
  ocean1: "#0d1f29", ocean2: "#15303d",
  land: "#1f2e25", landHi: "#2d4032",
  grid: "#1f3a3a",
  phosphor: "#b8ff5e", phosphorDim: "#6ba33a",
  amber: "#ffb84a", amberDim: "#a87a2e",
  hostile: "#ff4757", hostileDim: "#a82a36",
  neutral: "#5fb3d4", neutralDim: "#3a6b80",
  subsurface: "#c66bff", subsurfaceDim: "#7a3ea3",
  ais: "#29e0d4", aisDim: "#1a8a83",
  text: "#c8d4cc", textDim: "#6b7d72",
};

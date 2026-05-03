export const CONFIG = {
  WORLD_W: 6400, WORLD_H: 4000,

  USV_SPEED: 0.45, UAV_SPEED: 2.2,
  ENEMY_SPEED: 0.35, COMMERCIAL_SPEED: 0.1,
  SUBMARINE_SPEED: 0.22,

  UAV_ORBIT_RADIUS: 90, UAV_ORBIT_ANGULAR_SPEED: 0.012,
  UAV_BATTERY_DRAIN: 0.04, UAV_CHARGE_RATE: 0.18,
  UAV_LOW_BATTERY: 28, UAV_FULL_BATTERY: 95, UAV_DOCK_RANGE: 8,

  USV_BATTERY_DRAIN: 0.008, USV_SOLAR_RATE: 0.04, USV_LOW_BATTERY: 40,

  USV_SENSOR_RANGE: 180, UAV_SENSOR_RANGE: 240, SONAR_RANGE: 130,
  FOG_REVEAL_RANGE: 260,

  CONFIDENCE_RATE: 0.9, CONFIDENCE_DECAY: 0.15,
  POSSIBLE_THRESHOLD: 35, CONFIRMED_THRESHOLD: 75,
  // Mines are stationary so detection is faster once sonar reaches them
  MINE_DETECTION_BOOST: 1.4,

  TICK_MS: 50,
  EDGE_PAN_ZONE: 36, EDGE_PAN_SPEED: 16,

  JAM_ZONE_RADIUS: 280,
  PATROL_LANES: 6,
  TRACK_STANDOFF: 90,
  UAV_MISSION_ORBIT_RADIUS: 60,

  // Phase 4: First Island Chain — Taiwan, Phils, Guam, Japan, Korea, E China Sea
  // Lon span 116°-148° (32°) → 6400 world units; Lat 5°-42° (37°) → 4000 world
  GEO_LON_MIN: 116, GEO_LON_MAX: 148,
  GEO_LAT_MIN:   5, GEO_LAT_MAX:  42,

  AIS_TICK_MS: 1000,        // simulated AIS update cadence (real time)
  AIS_VESSEL_COUNT: 64,     // synthetic fleet size
  // UAV mission abort math
  UAV_RETURN_BATTERY_MARGIN: 8, // % safety pad
};

export const COLORS = {
  bg: "#08100c", surface: "#0d1612", surfaceHi: "#121e18",
  border: "#1f3329", borderHi: "#2d4a3c",
  ocean1: "#0d1f29", ocean2: "#15303d", land: "#1f2e25", landHi: "#2d4032",
  grid: "#1f3a3a",
  phosphor: "#b8ff5e", phosphorDim: "#6ba33a",
  amber: "#ffb84a", amberDim: "#a87a2e",
  hostile: "#ff4757", hostileDim: "#a82a36",
  neutral: "#5fb3d4", neutralDim: "#3a6b80",
  subsurface: "#c66bff", subsurfaceDim: "#7a3ea3",
  ais: "#29e0d4", aisDim: "#1a8a83",
  text: "#c8d4cc", textDim: "#6b7d72",
};

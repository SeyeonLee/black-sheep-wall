import { CONFIG } from "../config";
import { geoToWorld } from "../utils";

// ─── ID factory ──────────────────────────────────────────────────────────────
let _idCounter = 1;
export const newId = (p) => `${p}-${_idCounter++}`;

// ─── Unit factories ───────────────────────────────────────────────────────────
export const createISRUnit = (x, y, n = 1, settings = {}) => {
  const usvId = newId("usv");
  return [
    { id: usvId, type: "USV", faction: "friendly", x, y, heading: 0,
      battery: settings.battery ?? 92,
      state: "idle", goal: null, label: `ISR-${n}`, patrolPath: null, patrolIdx: 0,
      engageTargetId: null, aisEngageMMSI: null,
      speed: settings.speed ?? CONFIG.USV_SPEED,
      health: settings.health ?? CONFIG.HEALTH_USV,
      maxHealth: settings.health ?? CONFIG.HEALTH_USV },
    { id: newId("uav"), type: "UAV", faction: "friendly", x, y, heading: 0, battery: 88,
      state: "orbiting", parentId: usvId, orbitAngle: 0, label: "α",
      missionTarget: null, trackTargetId: null, missionAborted: false,
      health: 5, maxHealth: 5 },
    { id: newId("uav"), type: "UAV", faction: "friendly", x, y, heading: 0, battery: 100,
      state: "docked", parentId: usvId, orbitAngle: Math.PI, label: "β",
      missionTarget: null, trackTargetId: null, missionAborted: false,
      health: 5, maxHealth: 5 },
  ];
};

export const createTurretUnit = (x, y, n = 1, settings = {}) => ({
  id: newId("trt"), type: "TURRET", faction: "friendly",
  x, y, heading: 0,
  battery: settings.battery ?? 92,
  state: "idle", goal: null, label: `TRT-${n}`, patrolPath: null, patrolIdx: 0,
  engageTargetId: null,
  attackMode: false,
  attackSuppressed: false,
  ammo: settings.ammo ?? CONFIG.TURRET_AMMO,
  maxAmmo: settings.ammo ?? CONFIG.TURRET_AMMO,
  isFiring: false,
  speed: settings.speed ?? CONFIG.TURRET_SPEED,
  health: settings.health ?? CONFIG.HEALTH_TURRET,
  maxHealth: settings.health ?? CONFIG.HEALTH_TURRET,
});

export const createCommercialVessel = (x, y, settings = {}) => ({
  id: newId("com"), type: "COMMERCIAL", faction: "neutral",
  x, y, heading: Math.random() * Math.PI * 2, battery: 100, state: "transit",
  goal: { x: x + (Math.random() - 0.5) * 1500, y: y + (Math.random() - 0.5) * 1500 },
  label: `MV-${Math.floor(Math.random() * 900 + 100)}`,
  mmsi: `${Math.floor(Math.random() * 900000000 + 100000000)}`,
  imo: `IMO${Math.floor(Math.random() * 9000000 + 1000000)}`,
  flag: ["KOR", "PAN", "LBR", "MSH", "SGP", "HKG"][Math.floor(Math.random() * 6)],
  vesselType: ["TANKER", "CARGO", "BULK", "CONT"][Math.floor(Math.random() * 4)],
  speed: settings.speed ?? CONFIG.COMMERCIAL_SPEED,
  health: settings.health ?? CONFIG.HEALTH_COMMERCIAL,
  maxHealth: settings.health ?? CONFIG.HEALTH_COMMERCIAL,
});

export const createEnemyVessel = (x, y, settings = {}) => ({
  id: newId("hos"), type: "ENEMY", faction: "hostile",
  x, y, heading: Math.random() * Math.PI * 2, battery: 100, state: "transit",
  goal: { x: x + (Math.random() - 0.5) * 1200, y: y + (Math.random() - 0.5) * 1200 },
  label: `UNK-${Math.floor(Math.random() * 99 + 10)}`,
  speed: settings.speed ?? CONFIG.ENEMY_SPEED,
  health: settings.health ?? CONFIG.HEALTH_ENEMY,
  maxHealth: settings.health ?? CONFIG.HEALTH_ENEMY,
});

export const createSubmarine = (x, y, settings = {}) => ({
  id: newId("sub"), type: "SUBMARINE", faction: "hostile",
  x, y, heading: Math.random() * Math.PI * 2, battery: 100, state: "transit",
  goal: { x: x + (Math.random() - 0.5) * 1200, y: y + (Math.random() - 0.5) * 1200 },
  label: `SS-${Math.floor(Math.random() * 99 + 10)}`,
  speed: settings.speed ?? CONFIG.SUBMARINE_SPEED,
  health: settings.health ?? CONFIG.HEALTH_SUBMARINE,
  maxHealth: settings.health ?? CONFIG.HEALTH_SUBMARINE,
});

export const createMine = (x, y, settings = {}) => ({
  id: newId("min"), type: "MINE", faction: "hostile",
  x, y, heading: 0, battery: 100, state: "moored",
  goal: null, label: `MIN-${Math.floor(Math.random() * 99 + 10)}`,
  health: settings.health ?? CONFIG.HEALTH_MINE,
  maxHealth: settings.health ?? CONFIG.HEALTH_MINE,
});

export const createJamZone = (x, y) => ({
  id: newId("jam"), x, y, radius: CONFIG.JAM_ZONE_RADIUS,
  label: `JAM-${Math.floor(Math.random() * 99 + 10)}`,
});

// ─── Synthetic AIS fleet ──────────────────────────────────────────────────────
// Realistic shipping lanes through First Island Chain chokepoints (lon/lat).
const FLAG_DATA = [
  { flag: "PAN", mid: 357, names: ["PACIFIC HORIZON","ATLAS PIONEER","NEPTUNE STAR","BLUE EVEREST","ORIENT ENVOY"] },
  { flag: "LBR", mid: 636, names: ["EVER GIVEN","MAERSK ANTARES","CMA CGM TRIDENT","COSCO HARMONY","HAFNIA SAPPHIRE"] },
  { flag: "MSH", mid: 538, names: ["NORDIC ORION","STAR CHALLENGER","BBC EUROPE","AMAZON RIVER","KING ROBERT"] },
  { flag: "SGP", mid: 563, names: ["NEPTUNE GALAXY","APL TEMASEK","KEPPEL VICTORY","JURONG PRIDE","HARBOUR EAGLE"] },
  { flag: "HKG", mid: 477, names: ["VICTORIA HARBOUR","ORIENT OVERSEAS","HKG NAVIGATOR","KOWLOON STAR","PEARL RIVER"] },
  { flag: "JPN", mid: 431, names: ["MOL TRIUMPH","NYK ALTAIR","K-LINE PIONEER","SAKURA EXPRESS","FUJI VENTURE"] },
  { flag: "CHN", mid: 412, names: ["COSCO SHANGHAI","CHINA MERCHANTS","SHENZHEN BAY","HUANG HE STAR","XIN HONG KONG"] },
  { flag: "KOR", mid: 440, names: ["HMM ALGECIRAS","SM BUSAN","KMTC INCHEON","HANJIN BLUE","DAEHAN VICTORY"] },
  { flag: "PHL", mid: 548, names: ["MANILA STAR","CEBU PACIFIC","DAVAO PRIDE","LUZON EXPRESS","VISAYAN SEA"] },
  { flag: "TWN", mid: 416, names: ["EVERGREEN MARINE","YANG MING SUN","WAN HAI VICTORY","KEELUNG STAR","TAIPEI EXPRESS"] },
  { flag: "USA", mid: 366, names: ["USNS MERCY","MAERSK DENVER","HORIZON PACIFIC","AMERICAN HIGHWAY","MATSON KAUAI"] },
  { flag: "MLT", mid: 256, names: ["VALLETTA SPIRIT","GOZO STAR","LUQA EXPRESS","COMINO BRIDGE","MALTESE FALCON"] },
];

const SHIPPING_ROUTES = [
  { name: "SIN-TYO", waypoints: [
    {lon:117.0,lat:7.5},{lon:118.5,lat:12.0},{lon:120.5,lat:18.5},
    {lon:122.0,lat:21.5},{lon:124.0,lat:25.0},{lon:128.0,lat:28.5},
    {lon:134.0,lat:33.5},{lon:139.5,lat:35.0}]},
  { name: "TYO-PUS", waypoints: [
    {lon:139.5,lat:35.0},{lon:135.0,lat:33.5},{lon:132.0,lat:33.0},
    {lon:130.0,lat:33.5},{lon:129.2,lat:35.1}]},
  { name: "SHA-YOK", waypoints: [
    {lon:121.5,lat:31.0},{lon:124.0,lat:30.5},{lon:128.0,lat:31.0},
    {lon:132.0,lat:32.5},{lon:136.5,lat:34.5},{lon:139.7,lat:35.4}]},
  { name: "MNL-HKG", waypoints: [
    {lon:121.0,lat:14.5},{lon:119.0,lat:16.5},{lon:117.0,lat:19.5},
    {lon:114.2,lat:22.3}]},
  { name: "KHH-YOK", waypoints: [
    {lon:120.3,lat:22.5},{lon:122.5,lat:24.0},{lon:125.0,lat:25.5},
    {lon:128.0,lat:27.5},{lon:132.0,lat:31.0},{lon:136.0,lat:34.0},
    {lon:139.7,lat:35.4}]},
  { name: "PUS-SHA", waypoints: [
    {lon:129.2,lat:35.1},{lon:126.5,lat:34.5},{lon:124.0,lat:33.5},
    {lon:122.5,lat:32.0},{lon:121.5,lat:31.0}]},
  { name: "SIN-KHH", waypoints: [
    {lon:117.0,lat:7.5},{lon:116.5,lat:12.0},{lon:117.5,lat:16.0},
    {lon:119.0,lat:19.0},{lon:120.3,lat:22.5}]},
  { name: "MNL-GUM", waypoints: [
    {lon:121.0,lat:14.5},{lon:125.0,lat:13.8},{lon:130.0,lat:13.5},
    {lon:135.0,lat:13.4},{lon:144.7,lat:13.5}]},
  { name: "YOK-GUM", waypoints: [
    {lon:139.7,lat:35.4},{lon:141.0,lat:30.0},{lon:142.5,lat:24.0},
    {lon:144.0,lat:18.0},{lon:144.7,lat:13.5}]},
  { name: "JPN-COAST", waypoints: [
    {lon:141.5,lat:41.0},{lon:141.8,lat:38.0},{lon:141.0,lat:35.5},
    {lon:139.7,lat:35.0},{lon:137.0,lat:34.5},{lon:134.5,lat:34.0}]},
  { name: "TWN-STR", waypoints: [
    {lon:119.5,lat:25.5},{lon:119.0,lat:24.0},{lon:119.5,lat:22.5},
    {lon:120.5,lat:21.0}]},
  { name: "MNL-CEB", waypoints: [
    {lon:121.0,lat:14.5},{lon:122.5,lat:13.0},{lon:124.0,lat:11.0},
    {lon:124.0,lat:10.3}]},
];

const pointAlongRoute = (waypoints, t) => {
  const reflect = (Math.sin(t * Math.PI * 2 - Math.PI / 2) + 1) / 2;
  const segments = waypoints.length - 1;
  const f = reflect * segments;
  const i = Math.min(Math.floor(f), segments - 1);
  const lf = f - i;
  const a = waypoints[i], b = waypoints[i + 1];
  return { lon: a.lon + (b.lon - a.lon) * lf, lat: a.lat + (b.lat - a.lat) * lf };
};

export const generateAISFleet = () => {
  const fleet = [];
  const types = ["CARGO","CARGO","CARGO","TANKER","TANKER","BULK","CONTAINER","CONTAINER","PASSENGER","FISHING"];
  const dests = {
    "SIN-TYO":["TOKYO","YOKOHAMA"],"TYO-PUS":["BUSAN"],"SHA-YOK":["YOKOHAMA"],
    "MNL-HKG":["HONG KONG"],"KHH-YOK":["YOKOHAMA"],"PUS-SHA":["SHANGHAI"],
    "SIN-KHH":["KAOHSIUNG"],"MNL-GUM":["APRA HARBOR"],"YOK-GUM":["APRA HARBOR"],
    "JPN-COAST":["KOBE","NAGOYA"],"TWN-STR":["KEELUNG","KAOHSIUNG"],"MNL-CEB":["CEBU CITY"],
  };
  let idx = 0;
  while (fleet.length < CONFIG.AIS_VESSEL_COUNT) {
    const route = SHIPPING_ROUTES[idx % SHIPPING_ROUTES.length];
    const flagInfo = FLAG_DATA[Math.floor(Math.random() * FLAG_DATA.length)];
    const name = flagInfo.names[Math.floor(Math.random() * flagInfo.names.length)] +
                 ` ${Math.floor(Math.random() * 99 + 1)}`;
    const tail = Math.floor(Math.random() * 1000000).toString().padStart(6, "0");
    const mmsi = `${flagInfo.mid}${tail}`;
    const type = types[Math.floor(Math.random() * types.length)];
    const baseSpeed = type === "CONTAINER" ? 0.00045 : type === "PASSENGER" ? 0.00060 :
                      type === "FISHING"   ? 0.00018 : type === "TANKER"    ? 0.00030 : 0.00038;
    const sog = type === "CONTAINER" ? 18 + Math.random() * 4 :
                type === "PASSENGER" ? 22 + Math.random() * 4 :
                type === "FISHING"   ? 6  + Math.random() * 3 :
                type === "TANKER"    ? 11 + Math.random() * 3 :
                                        12 + Math.random() * 4;
    const initialT = Math.random();
    const start = pointAlongRoute(route.waypoints, initialT);
    const wp = geoToWorld(start.lat, start.lon);
    fleet.push({
      mmsi, name, lat: start.lat, lon: start.lon, wx: wp.x, wy: wp.y,
      cog: 0, sog, heading: 0, type, flag: flagInfo.flag,
      dest: (dests[route.name] || ["—"])[0],
      imo: `IMO${Math.floor(Math.random() * 9000000 + 1000000)}`,
      route: route.waypoints, routeName: route.name,
      routePos: initialT, routeSpeed: baseSpeed,
    });
    idx++;
  }
  return fleet;
};

export { pointAlongRoute };

// ─── Initial state ────────────────────────────────────────────────────────────
export const makeInitialState = () => {
  // 124°E, 22°N in the expanded Indo-Pacific coordinate system
  // x = (124-60)/120 * 6400 ≈ 3413,  y = (70-22)/90 * 4000 ≈ 2133
  const isr = createISRUnit(3413, 2133, 1);
  return {
    units: [...isr],
    detections: {},
    alerts: [],
    mineMarkers: [],
    patrolAreas: [],
    jamZones: [],
    aisShips: [],        // populated by synthetic fleet in App.jsx
    selectedIds: [],
    fogReveal: [],
    simSpeed: 1, paused: false, simTime: 0,
    isrCount: 1,
    turretCount: 0,
    unitSettings: {
      USV:        { speed: CONFIG.USV_SPEED,        battery: 92,  health: CONFIG.HEALTH_USV },
      TURRET:     { speed: CONFIG.TURRET_SPEED,     battery: 92,  health: CONFIG.HEALTH_TURRET },
      ENEMY:      { speed: CONFIG.ENEMY_SPEED,                    health: CONFIG.HEALTH_ENEMY },
      COMMERCIAL: { speed: CONFIG.COMMERCIAL_SPEED,               health: CONFIG.HEALTH_COMMERCIAL },
      SUBMARINE:  { speed: CONFIG.SUBMARINE_SPEED,                health: CONFIG.HEALTH_SUBMARINE },
      MINE:       {                                               health: CONFIG.HEALTH_MINE },
    },
  };
};

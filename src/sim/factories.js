import { CONFIG } from "../config";
import { geoToWorld } from "../utils";

// ─── LAND: First Island Chain silhouettes ────────────────────────────────────
// World coords 6400×4000. Geo: 116°E–148°E, 5°N–42°N
export const LAND = [
  // Mainland China east coast (left edge)
  "M 0 0 L 1850 0 L 1820 200 L 1740 380 L 1660 540 L 1580 720 L 1480 920 L 1380 1120 L 1250 1300 L 1100 1500 L 950 1700 L 800 1900 L 700 2100 L 600 2350 L 500 2600 L 400 2900 L 300 3200 L 200 3500 L 100 3800 L 0 4000 Z",
  // Korean Peninsula
  "M 1820 250 L 1900 280 L 1960 380 L 2010 480 L 2030 600 L 2010 720 L 1980 820 L 1950 920 L 1900 1010 L 1840 1060 L 1780 1080 L 1730 1050 L 1700 980 L 1690 880 L 1700 760 L 1730 640 L 1770 520 L 1800 400 Z",
  // Jeju
  "M 1820 1130 Q 1870 1120 1880 1160 Q 1860 1190 1810 1180 Q 1790 1160 1820 1130 Z",
  // Japan: Honshu
  "M 2700 700 L 2820 680 L 2940 700 L 3060 750 L 3180 820 L 3280 900 L 3370 1000 L 3440 1110 L 3500 1230 L 3530 1350 L 3540 1460 L 3500 1530 L 3420 1560 L 3320 1540 L 3220 1490 L 3120 1420 L 3020 1330 L 2920 1230 L 2820 1130 L 2740 1020 L 2680 900 L 2670 800 Z",
  // Hokkaido
  "M 3120 380 L 3300 360 L 3460 410 L 3580 500 L 3620 620 L 3580 730 L 3460 770 L 3300 750 L 3160 690 L 3070 580 L 3070 470 Z",
  // Kyushu
  "M 2380 1340 L 2480 1320 L 2570 1360 L 2630 1440 L 2620 1540 L 2560 1620 L 2470 1640 L 2380 1610 L 2330 1530 L 2330 1420 Z",
  // Shikoku
  "M 2680 1280 L 2820 1260 L 2900 1310 L 2880 1380 L 2780 1410 L 2680 1380 L 2640 1330 Z",
  // Okinawa
  "M 2580 1820 Q 2640 1810 2660 1860 Q 2640 1920 2580 1910 Q 2550 1880 2580 1820 Z",
  // Miyako/Ishigaki
  "M 2480 2010 Q 2520 2000 2535 2030 Q 2520 2060 2475 2055 Q 2460 2035 2480 2010 Z",
  // Taiwan
  "M 2200 2150 L 2270 2130 L 2310 2200 L 2330 2310 L 2320 2440 L 2290 2540 L 2250 2580 L 2210 2560 L 2190 2480 L 2180 2360 L 2185 2240 Z",
  // Philippines: Luzon
  "M 2400 2700 L 2510 2680 L 2580 2720 L 2620 2810 L 2640 2920 L 2620 3030 L 2570 3100 L 2500 3110 L 2440 3070 L 2390 2980 L 2380 2860 L 2390 2780 Z",
  // Mindoro
  "M 2470 3140 Q 2530 3130 2545 3180 Q 2520 3220 2470 3210 Q 2455 3180 2470 3140 Z",
  // Samar/Leyte
  "M 2620 3170 L 2700 3160 L 2740 3220 L 2730 3290 L 2680 3320 L 2630 3290 L 2610 3230 Z",
  // Palawan
  "M 2150 3220 L 2240 3210 L 2330 3260 L 2400 3340 L 2430 3420 L 2400 3460 L 2330 3450 L 2240 3400 L 2160 3330 L 2130 3270 Z",
  // Mindanao
  "M 2540 3380 L 2700 3360 L 2820 3400 L 2870 3470 L 2860 3560 L 2790 3620 L 2680 3640 L 2570 3620 L 2490 3560 L 2470 3470 L 2500 3410 Z",
  // Guam
  "M 3540 3000 Q 3580 2990 3590 3015 Q 3580 3035 3545 3030 Q 3530 3015 3540 3000 Z",
  // Saipan
  "M 3530 2880 Q 3560 2872 3568 2895 Q 3558 2912 3530 2908 Q 3520 2892 3530 2880 Z",
  // Borneo (SW)
  "M 1700 3500 L 1900 3480 L 2080 3520 L 2200 3580 L 2270 3680 L 2240 3800 L 2120 3880 L 1960 3920 L 1800 3920 L 1660 3870 L 1580 3780 L 1580 3660 L 1640 3560 Z",
];

// ─── ID factory ──────────────────────────────────────────────────────────────
let _idCounter = 1;
export const newId = (p) => `${p}-${_idCounter++}`;

// ─── Unit factories ───────────────────────────────────────────────────────────
export const createISRUnit = (x, y, n = 1) => {
  const usvId = newId("usv");
  return [
    { id: usvId, type: "USV", faction: "friendly", x, y, heading: 0, battery: 92,
      state: "idle", goal: null, label: `ISR-${n}`, patrolPath: null, patrolIdx: 0,
      engageTargetId: null, aisEngageMMSI: null },
    { id: newId("uav"), type: "UAV", faction: "friendly", x, y, heading: 0, battery: 88,
      state: "orbiting", parentId: usvId, orbitAngle: 0, label: "α",
      missionTarget: null, missionAborted: false },
    { id: newId("uav"), type: "UAV", faction: "friendly", x, y, heading: 0, battery: 100,
      state: "docked", parentId: usvId, orbitAngle: Math.PI, label: "β",
      missionTarget: null, missionAborted: false },
  ];
};

export const createCommercialVessel = (x, y) => ({
  id: newId("com"), type: "COMMERCIAL", faction: "neutral",
  x, y, heading: Math.random() * Math.PI * 2, battery: 100, state: "transit",
  goal: { x: x + (Math.random() - 0.5) * 1500, y: y + (Math.random() - 0.5) * 1500 },
  label: `MV-${Math.floor(Math.random() * 900 + 100)}`,
  mmsi: `${Math.floor(Math.random() * 900000000 + 100000000)}`,
  imo: `IMO${Math.floor(Math.random() * 9000000 + 1000000)}`,
  flag: ["KOR", "PAN", "LBR", "MSH", "SGP", "HKG"][Math.floor(Math.random() * 6)],
  vesselType: ["TANKER", "CARGO", "BULK", "CONT"][Math.floor(Math.random() * 4)],
});

export const createEnemyVessel = (x, y) => ({
  id: newId("hos"), type: "ENEMY", faction: "hostile",
  x, y, heading: Math.random() * Math.PI * 2, battery: 100, state: "transit",
  goal: { x: x + (Math.random() - 0.5) * 1200, y: y + (Math.random() - 0.5) * 1200 },
  label: `UNK-${Math.floor(Math.random() * 99 + 10)}`,
});

export const createSubmarine = (x, y) => ({
  id: newId("sub"), type: "SUBMARINE", faction: "hostile",
  x, y, heading: Math.random() * Math.PI * 2, battery: 100, state: "transit",
  goal: { x: x + (Math.random() - 0.5) * 1200, y: y + (Math.random() - 0.5) * 1200 },
  label: `SS-${Math.floor(Math.random() * 99 + 10)}`,
});

export const createMine = (x, y) => ({
  id: newId("min"), type: "MINE", faction: "hostile",
  x, y, heading: 0, battery: 100, state: "moored",
  goal: null, label: `MIN-${Math.floor(Math.random() * 99 + 10)}`,
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
  const isr = createISRUnit(2400, 1900, 1);
  return {
    units: [...isr],
    detections: {},
    alerts: [],
    patrolAreas: [],
    jamZones: [],
    aisShips: [],        // populated by synthetic fleet in App.jsx
    selectedIds: [],
    fogReveal: [],
    simSpeed: 1, paused: false, simTime: 0,
    isrCount: 1,
  };
};

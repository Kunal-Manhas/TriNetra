const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();
const axios = require('axios');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────────────────────
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'postgres',
  password: process.env.DB_PASS || 'Kunal1234@',
  port: process.env.DB_PORT || 5432,
});

// ─────────────────────────────────────────────────────────────
// ENCRYPTION HELPERS (End-to-End Location Data)
// ─────────────────────────────────────────────────────────────
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex').slice(0, 32);
const IV_LENGTH = 16;

function encryptLocation(lat, lng) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  const payload = JSON.stringify({ lat, lng, ts: Date.now() });
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptLocation(encryptedStr) {
  const [ivHex, encHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return JSON.parse(decrypted.toString());
}

// ─────────────────────────────────────────────────────────────
// HAVERSINE DISTANCE (km)
// ─────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─────────────────────────────────────────────────────────────
// IN-MEMORY STORE (for demo; replace with Redis in prod)
// ─────────────────────────────────────────────────────────────
const activeSOS = new Map();          // sosId -> { userId, encryptedLoc, time, socketId }
const userReports = [];               // crowd-sourced threat reports
const connectedUsers = new Map();     // socketId -> { userId, lat, lng, encLoc }

// ─────────────────────────────────────────────────────────────
// KNOWN SAFE HAVENS (India – extend as needed)
// ─────────────────────────────────────────────────────────────
const SAFE_HAVENS = [
  { name: "AIIMS Delhi",        type: "hospital",    lat: 28.5672, lng: 77.2100 },
  { name: "AIIMS Mumbai",       type: "hospital",    lat: 19.0760, lng: 72.8777 },
  { name: "Delhi Police HQ",   type: "police",      lat: 28.6448, lng: 77.2167 },
  { name: "Mumbai Police HQ",  type: "police",      lat: 18.9256, lng: 72.8312 },
  { name: "Bengaluru Police",  type: "police",      lat: 12.9716, lng: 77.5946 },
  { name: "Chennai Police",    type: "police",      lat: 13.0827, lng: 80.2707 },
  { name: "Hyderabad Police",  type: "police",      lat: 17.3850, lng: 78.4867 },
  { name: "Kolkata Police HQ", type: "police",      lat: 22.5726, lng: 88.3639 },
  { name: "Medanta Gurugram",  type: "hospital",    lat: 28.4089, lng: 77.0424 },
  { name: "Fortis Noida",      type: "hospital",    lat: 28.5355, lng: 77.3910 },
];

// ─────────────────────────────────────────────────────────────
// ROUTE 1: DANGER ZONES + THERMAL SCORING
// ─────────────────────────────────────────────────────────────
app.get('/api/danger-zones', async (req, res) => {
  try {
    const query = `
      SELECT district, state,
        ST_X(geom) as lng, ST_Y(geom) as lat,
        crime_rate, severity_weight
      FROM district_crime_data;
    `;
    const result = await pool.query(query);

    const scores = result.rows.map(row => {
      const rate = parseFloat(row.crime_rate) || 0;
      const weight = parseFloat(row.severity_weight) || 0.5;

      // Normalized safety score 1-10
      let safetyScore = 10 - (rate / 7);
      if (safetyScore < 1) safetyScore = 1;
      safetyScore = parseFloat(safetyScore.toFixed(1));

      // Thermal tier: RED / ORANGE / YELLOW / GREEN
      let thermalZone = 'GREEN';
      if (safetyScore <= 3)      thermalZone = 'RED';
      else if (safetyScore <= 5) thermalZone = 'ORANGE';
      else if (safetyScore <= 7) thermalZone = 'YELLOW';

      // Time-of-day risk modifier (+40% after 22:00)
      const hour = new Date().getHours();
      const nightRisk = (hour >= 22 || hour <= 5) ? 1.4 : 1.0;

      // Alert level for proximity engine
      let alertLevel = 0;
      if (safetyScore <= 3) alertLevel = 3;       // RED – COMBAT MODE
      else if (safetyScore <= 5) alertLevel = 2;  // ORANGE – CAUTION
      else if (safetyScore <= 7) alertLevel = 1;  // YELLOW – PULSE

      return {
        district: row.district,
        state: row.state,
        position: { lat: parseFloat(row.lat), lng: parseFloat(row.lng) },
        intensity: weight,
        safetyScore,
        thermalZone,
        alertLevel,
        crimeRate: rate,
        nightRiskFactor: nightRisk,
        districtIntel: {
          topThreats: ["Snatching", "Vehicle Theft", "Assault"], // placeholder
          commonCrimeTypes: rate > 40 ? ["Violent Crime", "Robbery"] : ["Petty Theft"],
          riskAfter10PM: `${Math.round((1 - (safetyScore / 10)) * 100 * nightRisk)}%`
        }
      };
    });

    res.json(scores);
  } catch (err) {
    console.error('[DANGER_ZONES_ERROR]', err.message);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 2: NEAREST SAFE HAVEN
// ─────────────────────────────────────────────────────────────



app.get('/api/nearest-safe-haven', async (req, res) => {
  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: "Latitude and longitude are required" });
    }

    // Overpass Query: Search for hospitals and police within 10,000 meters (10km)
    const query = `
      [out:json][timeout:25];
      (
        node["amenity"~"hospital|police"](around:10000,${lat},${lng});
        way["amenity"~"hospital|police"](around:10000,${lat},${lng});
      );
      out center 15;
    `;

    const response = await axios.get(
      `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`
    );

    // Map the raw OSM data into a clean format for your frontend
    const results = response.data.elements.map(element => ({
      id: element.id,
      type: element.tags.amenity, // "hospital" or "police"
      name: element.tags.name || (element.tags.amenity === 'police' ? 'Police Station' : 'Medical Center'),
      lat: element.lat || element.center.lat,
      lng: element.lon || element.center.lon,
      address: element.tags["addr:street"] || "Address not listed",
      phone: element.tags["phone"] || element.tags["contact:phone"] || "No phone listed"
    }));

    res.json(results);
  } catch (error) {
    console.error('[SAFE_HAVEN_ERROR]', error.message);
    // Fallback: If the API fails, return the local hardcoded SAFE_HAVENS as backup
    res.json(SAFE_HAVENS.slice(0, 5)); 
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 3: DISTRICT INTELLIGENCE DOSSIER
// ─────────────────────────────────────────────────────────────
app.get('/api/district-intel', async (req, res) => {
  const { district } = req.query;
  if (!district) return res.status(400).json({ error: "district required" });

  try {
    const result = await pool.query(
      `SELECT * FROM district_crime_data WHERE LOWER(district) = LOWER($1)`,
      [district]
    );

    if (result.rows.length === 0) {
      return res.json({ district, status: "NO_DATA", threats: [], safetyScore: 5 });
    }

    const row = result.rows[0];
    const safetyScore = Math.max(1, parseFloat((10 - row.crime_rate / 7).toFixed(1)));
    const hour = new Date().getHours();

    res.json({
      district: row.district,
      state: row.state,
      safetyScore,
      crimeRate: row.crime_rate,
      topThreats: ["Snatching", "Robbery", "Assault"],
      timeRisk: {
        current: hour >= 22 || hour <= 5 ? "HIGH (NIGHT)" : "MODERATE",
        worstWindow: "22:00 – 04:00",
        prediction: `This district is ${Math.round((1 - safetyScore / 10) * 40)}% riskier after 22:00`
      },
      status: "DOSSIER_FETCHED"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 4: USER-SUBMITTED INTEL (crowd-sourced reports)
// ─────────────────────────────────────────────────────────────
app.post('/api/report-threat', (req, res) => {
  const { userId, lat, lng, description, type } = req.body;
  if (!lat || !lng || !description) return res.status(400).json({ error: "Missing fields" });

  const report = {
    id: crypto.randomUUID(),
    userId: userId || 'ANONYMOUS',
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    description,
    type: type || 'SUSPICIOUS_ACTIVITY',
    timestamp: new Date().toISOString(),
    verified: false,
    encryptedLoc: encryptLocation(lat, lng)
  };

  userReports.push(report);

  // Broadcast to all connected admin dashboards
  io.emit('new-threat-report', {
    id: report.id,
    lat: report.lat,
    lng: report.lng,
    type: report.type,
    timestamp: report.timestamp
  });

  res.json({ status: "REPORT_RECEIVED", reportId: report.id });
});

app.get('/api/threat-reports', (req, res) => {
  res.json(userReports.filter(r => r.verified || r.userId !== 'ANONYMOUS').slice(-100));
});

// ─────────────────────────────────────────────────────────────
// ROUTE 5: ACTIVE SOS SIGNALS (Admin Commander Dashboard)
// ─────────────────────────────────────────────────────────────
app.get('/api/admin/active-sos', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== (process.env.ADMIN_KEY || 'safeguard_admin_2024')) {
    return res.status(403).json({ error: "UNAUTHORIZED" });
  }

  const signals = Array.from(activeSOS.values()).map(s => ({
    sosId: s.sosId,
    userId: s.userId,
    lat: s.lat,
    lng: s.lng,
    time: s.time,
    deviceId: s.deviceId
  }));

  res.json({ activeSignals: signals, count: signals.length });
});

// ─────────────────────────────────────────────────────────────
// ROUTE 6: OFFLINE MAP DATA (pre-loadable)
// ─────────────────────────────────────────────────────────────
app.get('/api/offline-bundle', async (req, res) => {
  const { lat, lng, radius } = req.query;
  try {
    // Fetch nearby zones for offline caching
    const result = await pool.query(`
      SELECT district, state, ST_X(geom) as lng, ST_Y(geom) as lat,
             crime_rate, severity_weight
      FROM district_crime_data
      LIMIT 500;
    `);

    const nearbyHavens = SAFE_HAVENS;
    const bundleTimestamp = new Date().toISOString();

    res.json({
      status: "OFFLINE_BUNDLE_READY",
      generatedAt: bundleTimestamp,
      expiresIn: "24h",
      zones: result.rows,
      safeHavens: nearbyHavens,
      version: "2.0.0"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// SOCKET.IO — REAL-TIME ENGINE
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[GRID_CONNECT] ${socket.id}`);

  // ── Register user location ──────────────────────────────────
  socket.on('register-location', (data) => {
    const { userId, lat, lng } = data;
    connectedUsers.set(socket.id, {
      userId, lat, lng,
      encLoc: encryptLocation(lat, lng),
      socketId: socket.id
    });
    console.log(`[LOCATION_REGISTERED] ${userId}`);
  });

  // ── SOS EXECUTE ─────────────────────────────────────────────
  socket.on('send-sos', (data) => {
    const sosId = crypto.randomUUID();
    const { userId, lat, lng, deviceId, silentMode } = data;

    const sosRecord = {
      sosId,
      userId: userId || 'UNKNOWN',
      lat: lat || 0,
      lng: lng || 0,
      deviceId: deviceId || socket.id,
      encryptedLoc: encryptLocation(lat || 0, lng || 0),
      time: new Date().toISOString(),
      socketId: socket.id,
      silentMode: silentMode || false
    };

    activeSOS.set(sosId, sosRecord);
    console.log(`🚨 [SOS] ${userId} at [${lat}, ${lng}] silentMode=${silentMode}`);

    // Broadcast to ALL connected clients (community watch)
    io.emit('receive-sos', {
      sosId,
      userId: sosRecord.userId,
      lat: sosRecord.lat,
      lng: sosRecord.lng,
      time: sosRecord.time,
      silentMode: sosRecord.silentMode
    });

    // Geo-fence: alert users within 1km radius
    connectedUsers.forEach((user, sid) => {
      if (sid === socket.id) return;
      const dist = haversine(lat, lng, user.lat, user.lng);
      if (dist <= 1) {
        io.to(sid).emit('geo-fence-alert', {
          sosId,
          distanceKm: parseFloat(dist.toFixed(2)),
          message: `SOS_SIGNAL: UNIT_IN_DISTRESS_${dist.toFixed(1)}KM_FROM_YOU`
        });
      }
    });

    socket.emit('sos-confirmed', { sosId, status: "BROADCASTED" });
  });

  // ── Emergency Reroute ───────────────────────────────────────
  socket.on('new-threat-active', (data) => {
    const { lat, lng, radius } = data;
    // Push emergency reroute to users near the threat
    connectedUsers.forEach((user, sid) => {
      const dist = haversine(lat, lng, user.lat, user.lng);
      if (dist <= (radius || 5)) {
        io.to(sid).emit('emergency-reroute', {
          threatLat: lat,
          threatLng: lng,
          distanceKm: parseFloat(dist.toFixed(2)),
          message: "NEW_THREAT_DETECTED: REROUTING_RECOMMENDED"
        });
      }
    });
  });

  // ── SOS Resolve (admin) ─────────────────────────────────────
  socket.on('resolve-sos', (data) => {
    const { sosId } = data;
    if (activeSOS.has(sosId)) {
      activeSOS.delete(sosId);
      io.emit('sos-resolved', { sosId });
    }
  });

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    // Remove any active SOS tied to this socket
    activeSOS.forEach((v, k) => {
      if (v.socketId === socket.id) activeSOS.delete(k);
    });
    console.log(`[GRID_DISCONNECT] ${socket.id}`);
  });
});

// ─────────────────────────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🛡️  SAFEGUARD v2.0 ENGINE → http://localhost:${PORT}`);
  console.log(`   SOS Signals:   /api/admin/active-sos`);
  console.log(`   Danger Zones:  /api/danger-zones`);
  console.log(`   Safe Havens:   /api/nearest-safe-haven`);
  console.log(`   Offline Bundle:/api/offline-bundle`);
});

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import axios from 'axios';
import { io } from 'socket.io-client';
import 'leaflet-routing-machine';

// ─────────────────────────────────────────────────────────────
// SOCKET CONNECTION
// ─────────────────────────────────────────────────────────────
const socket = io('http://localhost:5000');

// ─────────────────────────────────────────────────────────────
// HAVERSINE (client-side copy for proximity checks)
// ─────────────────────────────────────────────────────────────
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: LOCATION MARKER  (fixes noise + userPos save)
// ─────────────────────────────────────────────────────────────
function LocationMarker({ setLocalThreat, setUserPos, setAlertLevel, dangerZones }) {
  const map = useMap();

  useEffect(() => {
    const handleFlyTo = (e) => {
      map.flyTo([e.detail.lat, e.detail.lng], 14, { animate: true, duration: 2 });
      L.circleMarker([e.detail.lat, e.detail.lng], {
        radius: 10, color: '#ff3131', fillColor: '#ff3131',
        fillOpacity: 0.8, weight: 2
      })
      .addTo(map)
      .bindPopup(`
        <div class="custom-popup-inner">
          <strong style="color:#ff3131;">[TARGET_LOCKED]</strong><br/>
          <span style="font-size:10px;color:#888;">SCANNING_PROXIMITY...</span><br/>
          LAT: ${e.detail.lat.toFixed(4)}<br/>
          LNG: ${e.detail.lng.toFixed(4)}
        </div>
      `, { className: 'custom-popup' }).openPopup();
    };

    window.addEventListener('map-fly-to', handleFlyTo);

    map.locate().on("locationfound", (e) => {
      const { lat, lng } = e.latlng;
      setUserPos([lat, lng]);

      // Register with backend for geo-fencing
      socket.emit('register-location', { userId: 'USER_' + Date.now(), lat, lng });

      map.flyTo(e.latlng, 13, { animate: true, duration: 2 });

      L.circle(e.latlng, {
        radius: 300,
        color: '#39ff14', fillColor: '#39ff14',
        fillOpacity: 0.3, weight: 2
      }).addTo(map).bindPopup("RECON_USER_LOCATION_LOCKED").openPopup();

      // Night mode threat
      const hour = new Date().getHours();
      if (hour >= 22 || hour <= 5) {
        setLocalThreat("ELEVATED (NIGHT_MODE)");
        setAlertLevel(2);
      } else {
        setLocalThreat("SECURE");
        setAlertLevel(0);
      }

      // Proximity scan against danger zones
      if (dangerZones.length > 0) {
        let maxAlert = 0;
        dangerZones.forEach(zone => {
          if (!zone || !zone.position) return;
          const dist = getDistance(lat, lng, zone.position.lat, zone.position.lng);
          if (dist < 2 && zone.alertLevel > maxAlert) maxAlert = zone.alertLevel;
        });
        if (maxAlert > 0) setAlertLevel(maxAlert);
      }
    });

    return () => window.removeEventListener('map-fly-to', handleFlyTo);
  }, [map, setLocalThreat, setUserPos, setAlertLevel, dangerZones]);

  return null;
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: HEATMAP — fixed gradient for thermal zones
// ─────────────────────────────────────────────────────────────
function HeatmapLayer({ points }) {
  const map = useMap();
  const heatRef = useRef(null);

  useEffect(() => {
    if (!points || points.length === 0) return;

    // Remove previous layer cleanly
    if (heatRef.current) {
      try { map.removeLayer(heatRef.current); } catch (e) {}
      heatRef.current = null;
    }

    const heatData = points.filter(p => p && p.position).map(p => [
      parseFloat(p.position.lat),
      parseFloat(p.position.lng),
      // Invert: high threat (low safetyScore) = high intensity
      Math.max(0.1, Math.min(1.0, (10 - p.safetyScore) / 9))
    ]);

    // ── FIXED gradient: proper thermal zone colors ──
    const heat = L.heatLayer(heatData, {
      radius: 35,
      blur: 25,
      maxZoom: 10,
      minOpacity: 0.35,
      gradient: {
        0.0:  '#00ff88',   // GREEN  – safe
        0.35: '#39ff14',   // neon green
        0.55: '#ffff00',   // YELLOW – caution
        0.75: '#ff8c00',   // ORANGE – high threat
        1.0:  '#ff1a1a'    // RED    – extreme danger
      }
    });

    heat.addTo(map);
    heatRef.current = heat;

    return () => {
      if (heatRef.current) {
        try { map.removeLayer(heatRef.current); } catch (e) {}
        heatRef.current = null;
      }
    };
  }, [points, map]);

  return null;
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: ROUTING (noise-free, safest path)
// ─────────────────────────────────────────────────────────────
function RoutingLayer({ start, end, onRouteFound }) {
  const map = useMap();
  const routingRef = useRef(null);

  useEffect(() => {
    if (!map || !start || !end) return;

    // Teardown previous
    if (routingRef.current) {
      try {
        routingRef.current.getPlan().setWaypoints([]);
        map.removeControl(routingRef.current);
      } catch (e) {}
      routingRef.current = null;
    }

    const control = L.Routing.control({
      waypoints: [L.latLng(start[0], start[1]), L.latLng(end[0], end[1])],
      lineOptions: {
        styles: [{ color: '#39ff14', opacity: 0.85, weight: 5, dashArray: '10, 12' }]
      },
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: true,
      show: false,          // ← kills the white box
      createMarker: () => null
    });

    // Completely suppress the routing UI panel (the main noise source)
    control.on('routesfound', (e) => {
      const routes = e.routes;
      if (routes && routes.length > 0 && onRouteFound) {
        const summary = routes[0].summary;
        onRouteFound({
          distanceKm: (summary.totalDistance / 1000).toFixed(1),
          timeMin: Math.round(summary.totalTime / 60)
        });
      }
    });

    control.addTo(map);

    // Force hide container after it's added
    setTimeout(() => {
      const containers = document.querySelectorAll('.leaflet-routing-container');
      containers.forEach(c => { c.style.display = 'none'; });
    }, 100);

    routingRef.current = control;

    return () => {
      if (routingRef.current && map) {
        try {
          routingRef.current.getPlan().setWaypoints([]);
          map.removeControl(routingRef.current);
        } catch (e) {}
        routingRef.current = null;
      }
    };
  }, [map, start, end, onRouteFound]);

  return null;
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: SAFE HAVEN MARKERS
// ─────────────────────────────────────────────────────────────
function SafeHavenMarkers({ havens }) {
  const map = useMap();
  const markersRef = useRef([]);

  useEffect(() => {
    // Clear old
    markersRef.current.forEach(m => { try { map.removeLayer(m); } catch (e) {} });
    markersRef.current = [];

    havens.forEach(h => {
      const color = h.type === 'police' ? '#4488ff' : '#ff44aa';
      const icon = h.type === 'police' ? '🚔' : '🏥';
      const marker = L.circleMarker([h.lat, h.lng], {
        radius: 8, color, fillColor: color, fillOpacity: 0.7, weight: 2
      }).addTo(map);
      marker.bindPopup(`
        <div class="custom-popup-inner" style="min-width:160px">
          <strong style="color:${color};">${icon} ${h.name}</strong><br/>
          <span style="font-size:10px;color:#aaa;">${h.type.toUpperCase()}</span><br/>
          <span style="color:#39ff14;">~${h.distanceKm} km away</span>
        </div>
      `, { className: 'custom-popup' });
      markersRef.current.push(marker);
    });

    return () => {
      markersRef.current.forEach(m => { try { map.removeLayer(m); } catch (e) {} });
      markersRef.current = [];
    };
  }, [havens, map]);

  return null;
}

// ─────────────────────────────────────────────────────────────
// ALERT LEVEL CONFIG
// ─────────────────────────────────────────────────────────────
const ALERT_CONFIG = {
  0: { color: '#39ff14', label: 'SECURE', glow: 'rgba(57,255,20,0.3)',  pulse: false },
  1: { color: '#ffff00', label: 'CAUTION: ZONE_APPROACHING', glow: 'rgba(255,255,0,0.3)', pulse: true  },
  2: { color: '#ff8c00', label: 'HIGH-THREAT SECTOR', glow: 'rgba(255,140,0,0.4)', pulse: true  },
  3: { color: '#ff1a1a', label: '⚠ COMBAT MODE — IMMEDIATE DANGER', glow: 'rgba(255,26,26,0.5)', pulse: true  },
};

// ─────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────
function App() {
  const [data, setData]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [localThreat, setLocalThreat] = useState("SECURE");
  const [alertLevel, setAlertLevel]   = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [userPos, setUserPos]     = useState(null);
  const [destPos, setDestPos]     = useState(null);
  const [isScanning, setIsScanning]   = useState(false);
  const [routeInfo, setRouteInfo] = useState(null);
  const [nearestHaven, setNearestHaven] = useState(null);
  const [distToSafety, setDistToSafety] = useState(null);
  const [safeHavens, setSafeHavens]     = useState([]);
  const [showHavens, setShowHavens]     = useState(false);
  const [activeSOS, setActiveSOS] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [silentMode, setSilentMode]   = useState(false);
  const [showDossier, setShowDossier] = useState(false);
  const [dossier, setDossier]     = useState(null);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [offlineReady, setOfflineReady]     = useState(false);
  const [offlineData, setOfflineData]       = useState(null);
  const [reportMode, setReportMode] = useState(false);
  const [reportDesc, setReportDesc] = useState("");
  const [reportPos, setReportPos]   = useState(null);
  const pulseRef = useRef(null);

  // ── Push notification helper ──────────────────────────────
  const pushNotif = useCallback((msg, type = 'info') => {
    const id = Date.now();
    setNotifications(prev => [...prev.slice(-4), { id, msg, type }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 6000);
  }, []);

  // ── Fetch danger zones ────────────────────────────────────
  useEffect(() => {
    axios.get('http://localhost:5000/api/danger-zones')
      .then(res => { setData(res.data); setLoading(false); })
      .catch(err => {
        console.error("CRITICAL_API_FAILURE:", err);
        setLoading(false);
        pushNotif("⚠ BACKEND_OFFLINE — Using cached data", 'warn');
        // Load from offline bundle if available
        const cached = localStorage.getItem('sg_offline_bundle');
        if (cached) {
          try {
            const bundle = JSON.parse(cached);
            setData(bundle.zones || []);
            setOfflineReady(true);
          } catch (e) {}
        }
      });
  }, [pushNotif]);

  // ── Socket event listeners ────────────────────────────────
  useEffect(() => {
    socket.on('receive-sos', (data) => {
      setActiveSOS(prev => [...prev, data]);
      pushNotif(`🚨 SOS ALERT: ${data.userId} at [${data.lat?.toFixed(3)}, ${data.lng?.toFixed(3)}]`, 'danger');
    });

    socket.on('geo-fence-alert', (data) => {
      pushNotif(`🔴 GEO-FENCE: SOS signal ${data.distanceKm}km from you!`, 'danger');
    });

    socket.on('emergency-reroute', (data) => {
      pushNotif(`⚡ EMERGENCY REROUTE: New threat ${data.distanceKm}km away`, 'warn');
    });

    socket.on('new-threat-report', (data) => {
      pushNotif(`👁 CROWD INTEL: ${data.type} reported nearby`, 'info');
    });

    socket.on('sos-confirmed', (data) => {
      pushNotif(`✅ SOS BROADCASTED — ID: ${data.sosId.slice(0, 8)}`, 'success');
    });

    return () => {
      socket.off('receive-sos');
      socket.off('geo-fence-alert');
      socket.off('emergency-reroute');
      socket.off('new-threat-report');
      socket.off('sos-confirmed');
    };
  }, [pushNotif]);

  // ── Proximity perimeter scan ──────────────────────────────
  useEffect(() => {
    if (!userPos || data.length === 0) return;

    const [uLat, uLng] = userPos;
    let maxLevel = alertLevel;

    data.forEach(zone => {
      const dist = getDistance(uLat, uLng, zone.position.lat, zone.position.lng);
      if (dist < 2 && zone.alertLevel === 3 && maxLevel < 3) {
        maxLevel = 3;
        setLocalThreat("IMMEDIATE_DANGER: HIGH-CRIME_ZONE_ENTERED");
      } else if (dist < 2 && zone.alertLevel === 2 && maxLevel < 2) {
        maxLevel = 2;
        setLocalThreat("HIGH-THREAT: 2KM_PROXIMITY");
        pushNotif("🟠 CAUTION: Entering High-Crime Sector", 'warn');
      } else if (dist < 5 && zone.alertLevel === 1 && maxLevel < 1) {
        maxLevel = 1;
        setLocalThreat("APPROACHING_CAUTION_ZONE");
      }
    });

    setAlertLevel(maxLevel);
  }, [userPos, data]); // eslint-disable-line

  // ── Fetch nearest safe haven when user moves ──────────────
  useEffect(() => {
    if (!userPos) return;
    const [lat, lng] = userPos;
    axios.get(`http://localhost:5000/api/nearest-safe-haven?lat=${lat}&lng=${lng}`)
      .then(res => {
        setNearestHaven(res.data.nearest);
        setDistToSafety(res.data.nearest?.distanceKm);
        if (showHavens) setSafeHavens(res.data.allHavens || []);
      })
      .catch(() => {});
  }, [userPos, showHavens]);

  // ── Offline bundle pre-load ────────────────────────────────
  const preloadOffline = async () => {
    try {
      const res = await axios.get('http://localhost:5000/api/offline-bundle');
      localStorage.setItem('sg_offline_bundle', JSON.stringify(res.data));
      setOfflineData(res.data);
      setOfflineReady(true);
      pushNotif("✅ OFFLINE MAP CACHED — valid 24h", 'success');
    } catch (e) {
      pushNotif("⚠ OFFLINE_CACHE_FAILED", 'warn');
    }
  };

  // ── Search handler ────────────────────────────────────────
  const handleSearch = async (e) => {
    if (e.key !== 'Enter') return;
    setIsScanning(true);
    setRouteInfo(null);

    try {
      const res = await axios.get(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&countrycodes=in&limit=1`
      );

      if (res.data.length > 0) {
        const { lat, lon } = res.data[0];
        const latNum = parseFloat(lat);
        const lonNum = parseFloat(lon);

        setDestPos([latNum, lonNum]);
        window.dispatchEvent(new CustomEvent('map-fly-to', { detail: { lat: latNum, lng: lonNum } }));

        // Threat scan at destination
        setTimeout(() => {
          const threats = data.filter(p =>
            p && p.position &&
            getDistance(latNum, lonNum, p.position.lat, p.position.lng) < 10
          );
          const worst = threats.sort((a, b) => a.safetyScore - b.safetyScore)[0];
          if (worst && worst.safetyScore < 4) {
            setLocalThreat(`DANGER: HIGH-THREAT @ DESTINATION (Score: ${worst.safetyScore})`);
            setAlertLevel(3);
          } else if (worst && worst.safetyScore < 6) {
            setLocalThreat(`CAUTION: MODERATE RISK @ DESTINATION`);
            setAlertLevel(2);
          } else {
            setLocalThreat("SECURE: PATH_CLEAR");
            setAlertLevel(0);
          }

          // Fetch district intel
          axios.get(`http://localhost:5000/api/district-intel?district=${searchQuery}`)
            .then(r => { setDossier(r.data); setShowDossier(true); })
            .catch(() => {});

          setIsScanning(false);
        }, 2500);
      } else {
        pushNotif("LOCATION_NOT_FOUND", 'warn');
        setIsScanning(false);
      }
    } catch (err) {
      console.error("SEARCH_ERROR:", err);
      setIsScanning(false);
    }
  };

  // ── SOS EXECUTE ───────────────────────────────────────────
  const handleSOS = () => {
    const payload = {
      userId: 'KUNAL_DEV_01',
      lat: userPos?.[0],
      lng: userPos?.[1],
      deviceId: 'DEVICE_' + navigator.userAgent.slice(0, 20),
      timestamp: new Date().toISOString(),
      type: "MANUAL_TRIGGER",
      silentMode
    };
    socket.emit('send-sos', payload);
    if (!silentMode) pushNotif("🚨 SOS BROADCASTED TO ALL NODES", 'danger');
  };

  // ── Submit threat report ───────────────────────────────────
  const submitReport = async () => {
    if (!reportDesc || !userPos) return;
    try {
      await axios.post('http://localhost:5000/api/report-threat', {
        userId: 'USER_01',
        lat: userPos[0],
        lng: userPos[1],
        description: reportDesc,
        type: 'SUSPICIOUS_ACTIVITY'
      });
      pushNotif("✅ INTEL SUBMITTED FOR VERIFICATION", 'success');
      setReportDesc("");
      setReportMode(false);
    } catch (e) {
      pushNotif("⚠ REPORT_FAILED", 'warn');
    }
  };

  const alert = ALERT_CONFIG[alertLevel] || ALERT_CONFIG[0];

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100vh', background: '#0a0a0b', color: 'white', fontFamily: 'monospace', overflow: 'hidden' }}>

      {/* ── HEADER HUD ─────────────────────────────────────── */}
      <header style={{
        padding: '12px 20px', borderBottom: '1px solid #222',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'rgba(8,8,10,0.97)', zIndex: 2000, position: 'relative'
      }}>
        <div>
          <h2 style={{ color: '#39ff14', margin: 0, letterSpacing: '2px', fontSize: '15px' }}>
            ◈ TRI NETRA <span style={{ color: '#555' }}>//</span> NATIONAL_THREAT_MAP <span style={{ color: '#ff8c00', fontSize: '11px' }}>v2.0</span>
          </h2>
          <small style={{ color: '#555', fontSize: '10px' }}>
            NODES: {data.length} | {offlineReady ? '📦 OFFLINE_CACHED' : 'LIVE_STREAM'} | GRID: {Object.keys({...socket}).length > 0 ? 'CONNECTED' : 'OFFLINE'}
          </small>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* Silent Mode Toggle */}
          <button
            onClick={() => { setSilentMode(!silentMode); pushNotif(silentMode ? "SILENT_MODE OFF" : "🤫 SILENT_MODE ACTIVE", 'info'); }}
            style={{
              background: silentMode ? '#222' : 'transparent', color: silentMode ? '#ff8c00' : '#555',
              border: `1px solid ${silentMode ? '#ff8c00' : '#333'}`, padding: '8px 14px',
              cursor: 'pointer', fontFamily: 'monospace', fontSize: '11px', borderRadius: '3px'
            }}
          >
            {silentMode ? '🤫 SILENT' : '🔊 VOCAL'}
          </button>

          {/* Admin Panel */}
          <button
            onClick={() => setShowAdminPanel(!showAdminPanel)}
            style={{
              background: 'transparent', color: '#4488ff', border: '1px solid #4488ff',
              padding: '8px 14px', cursor: 'pointer', fontFamily: 'monospace', fontSize: '11px', borderRadius: '3px'
            }}
          >
            CMD_CENTER
          </button>

          {/* Offline Pre-load */}
          <button
            onClick={preloadOffline}
            style={{
              background: 'transparent', color: '#ffff00', border: '1px solid #ffff00',
              padding: '8px 14px', cursor: 'pointer', fontFamily: 'monospace', fontSize: '11px', borderRadius: '3px'
            }}
          >
            {offlineReady ? '📦 CACHED' : '⬇ OFFLINE'}
          </button>

          {/* SOS BUTTON */}
          <button
            onClick={handleSOS}
            style={{
              background: '#ff1a1a', color: 'white', border: 'none',
              padding: '10px 22px', cursor: 'pointer', fontWeight: 'bold',
              boxShadow: '0 0 20px rgba(255,26,26,0.6)', borderRadius: '4px',
              fontFamily: 'monospace', letterSpacing: '1px', animation: alertLevel === 3 ? 'sosFlash 0.8s infinite' : 'none'
            }}
          >
            🚨 EXECUTE SOS
          </button>
        </div>
      </header>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '90vh', flexDirection: 'column', gap: '10px' }}>
          <div style={{ color: '#39ff14', letterSpacing: '5px', animation: 'blink 1s infinite' }}>DECRYPTING_GEOSPATIAL_STREAM...</div>
          <div style={{ color: '#555', fontSize: '11px' }}>LOADING THREAT_NODES FROM BACKEND</div>
        </div>
      ) : (
        <div style={{ position: 'relative', height: 'calc(100vh - 58px)' }}>

          {/* ── SEARCH BAR ──────────────────────────────────── */}
          <div style={{ position: 'absolute', top: '15px', left: '60px', zIndex: 1000, width: '280px' }}>
            <input
              type="text"
              placeholder="SEARCH_DESTINATION..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={handleSearch}
              style={{
                width: '100%', padding: '10px 12px', boxSizing: 'border-box',
                background: 'rgba(10,10,14,0.92)', border: `1px solid ${alert.color}`,
                color: alert.color, fontFamily: 'monospace', outline: 'none',
                boxShadow: `0 0 8px ${alert.glow}`, fontSize: '12px', borderRadius: '3px'
              }}
            />
          </div>

          {/* ── TOOLBAR: SAFE HAVENS + REPORT ─────────────── */}
          <div style={{ position: 'absolute', top: '15px', right: '15px', zIndex: 1000, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <button
              onClick={() => { setShowHavens(!showHavens); }}
              style={{
                background: showHavens ? 'rgba(68,136,255,0.2)' : 'rgba(10,10,14,0.9)',
                color: '#4488ff', border: '1px solid #4488ff', padding: '8px 12px',
                cursor: 'pointer', fontFamily: 'monospace', fontSize: '10px', borderRadius: '3px',
                boxShadow: showHavens ? '0 0 10px rgba(68,136,255,0.4)' : 'none'
              }}
            >
              🏥 SAFE_HAVENS
            </button>
            <button
              onClick={() => setReportMode(!reportMode)}
              style={{
                background: reportMode ? 'rgba(255,140,0,0.15)' : 'rgba(10,10,14,0.9)',
                color: '#ff8c00', border: '1px solid #ff8c00', padding: '8px 12px',
                cursor: 'pointer', fontFamily: 'monospace', fontSize: '10px', borderRadius: '3px'
              }}
            >
              📡 REPORT_INTEL
            </button>
          </div>

          {/* ── MAP ─────────────────────────────────────────── */}
          <MapContainer center={[20.5937, 78.9629]} zoom={5} style={{ height: '100%', width: '100%' }}>
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; OpenStreetMap contributors &copy; CARTO'
            />
            <HeatmapLayer points={data} />
            <LocationMarker
              setLocalThreat={setLocalThreat}
              setUserPos={setUserPos}
              setAlertLevel={setAlertLevel}
              dangerZones={data}
            />
            {userPos && destPos && (
              <RoutingLayer
                start={userPos}
                end={destPos}
                onRouteFound={setRouteInfo}
              />
            )}
            {showHavens && safeHavens.length > 0 && (
              <SafeHavenMarkers havens={safeHavens} />
            )}
          </MapContainer>

          {/* ── MAIN STATUS HUD (bottom-left) ──────────────── */}
          <div style={{
            position: 'absolute', bottom: '20px', left: '15px', zIndex: 1000,
            background: 'rgba(8,8,10,0.88)', padding: '14px 16px',
            borderLeft: `4px solid ${isScanning ? '#ffff00' : alert.color}`,
            backdropFilter: 'blur(12px)', pointerEvents: 'none',
            boxShadow: `0 0 25px ${isScanning ? 'rgba(255,255,0,0.2)' : alert.glow}`,
            transition: 'all 0.4s ease', minWidth: '240px', borderRadius: '0 4px 4px 0'
          }}>
            <div style={{ color: '#444', fontSize: '9px', letterSpacing: '2px', marginBottom: '4px' }}>
              SYSTEM_INTEGRITY_CHECK
            </div>
            <div style={{ fontSize: '13px', fontWeight: 'bold', letterSpacing: '0.5px' }}>
              STATUS: <span style={{ color: isScanning ? '#ffff00' : alert.color }}>
                {isScanning ? "ANALYZING_SAFE_PATH..." : alert.label}
              </span>
            </div>
            <div style={{ fontSize: '10px', color: '#777', marginTop: '4px' }}>
              {localThreat}
            </div>
            <div style={{ fontSize: '10px', color: '#555', marginTop: '6px', borderTop: '1px solid #1a1a1a', paddingTop: '6px' }}>
              MONITORING: <span style={{ color: '#39ff14' }}>ACTIVE</span>
              {alertLevel > 0 && <span style={{ color: alert.color, marginLeft: '10px' }}>[PERIMETER_BREACH]</span>}
            </div>

            {/* Distance to safety */}
            {distToSafety && (
              <div style={{ fontSize: '10px', color: '#888', marginTop: '4px' }}>
                NEAREST_HAVEN: <span style={{ color: '#4488ff' }}>{nearestHaven?.name}</span>
                <br/>
                <span style={{ color: '#39ff14', fontSize: '12px' }}>▶ {distToSafety} km</span>
              </div>
            )}

            {/* Route info */}
            {routeInfo && (
              <div style={{ marginTop: '6px', borderTop: '1px solid #1a1a1a', paddingTop: '6px', fontSize: '10px' }}>
                <div style={{ color: '#39ff14' }}>ROUTE_LOCKED</div>
                <div style={{ color: '#aaa' }}>
                  DIST: <span style={{ color: '#39ff14' }}>{routeInfo.distanceKm} km</span>
                  &nbsp;|&nbsp; ETA: <span style={{ color: '#ffff00' }}>{routeInfo.timeMin} min</span>
                </div>
              </div>
            )}
          </div>

          {/* ── ALERT LEVEL BADGE (bottom-center) ──────────── */}
          <div style={{
            position: 'absolute', bottom: '20px', left: '50%',
            transform: 'translateX(-50%)', zIndex: 1000,
            background: 'rgba(8,8,10,0.9)', padding: '8px 20px',
            border: `1px solid ${alert.color}`,
            boxShadow: `0 0 15px ${alert.glow}`,
            backdropFilter: 'blur(10px)', borderRadius: '4px',
            animation: alert.pulse ? 'hudPulse 2s infinite' : 'none',
            pointerEvents: 'none'
          }}>
            <div style={{ fontSize: '10px', color: '#555', letterSpacing: '2px' }}>ALERT_LEVEL</div>
            <div style={{ fontSize: '16px', color: alert.color, fontWeight: 'bold', textAlign: 'center' }}>
              {alertLevel === 0 ? '● LEVEL_0' : alertLevel === 1 ? '◆ LEVEL_1' : alertLevel === 2 ? '■ LEVEL_2' : '🔴 LEVEL_3'}
            </div>
            <div style={{ fontSize: '9px', color: '#555', textAlign: 'center' }}>
              {['SECURE', 'YELLOW_PULSE', 'ORANGE_CAUTION', 'RED_COMBAT'][alertLevel]}
            </div>
          </div>

          {/* ── ACTIVE SOS COUNTER (bottom-right) ─────────── */}
          {activeSOS.length > 0 && (
            <div style={{
              position: 'absolute', bottom: '20px', right: '15px', zIndex: 1000,
              background: 'rgba(255,26,26,0.12)', border: '1px solid #ff1a1a',
              padding: '10px 14px', backdropFilter: 'blur(10px)', borderRadius: '4px',
              animation: 'sosFlash 1s infinite'
            }}>
              <div style={{ fontSize: '9px', color: '#ff1a1a', letterSpacing: '2px' }}>ACTIVE SOS SIGNALS</div>
              <div style={{ fontSize: '22px', color: '#ff1a1a', fontWeight: 'bold', textAlign: 'center' }}>
                {activeSOS.length}
              </div>
            </div>
          )}

          {/* ── NOTIFICATION FEED ───────────────────────────── */}
          <div style={{
            position: 'absolute', top: '60px', right: '15px', zIndex: 1001,
            display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '320px',
            pointerEvents: 'none'
          }}>
            {notifications.map(n => (
              <div key={n.id} style={{
                background: n.type === 'danger' ? 'rgba(255,26,26,0.15)' :
                             n.type === 'warn' ? 'rgba(255,140,0,0.15)' :
                             n.type === 'success' ? 'rgba(57,255,20,0.12)' : 'rgba(68,136,255,0.12)',
                border: `1px solid ${n.type === 'danger' ? '#ff1a1a' : n.type === 'warn' ? '#ff8c00' : n.type === 'success' ? '#39ff14' : '#4488ff'}`,
                padding: '8px 12px', borderRadius: '3px', fontSize: '11px',
                color: n.type === 'danger' ? '#ff6666' : n.type === 'warn' ? '#ffaa44' : n.type === 'success' ? '#66ff44' : '#88aaff',
                backdropFilter: 'blur(8px)', animation: 'slideIn 0.3s ease'
              }}>
                {n.msg}
              </div>
            ))}
          </div>

          {/* ── DISTRICT DOSSIER PANEL ───────────────────────── */}
          {showDossier && dossier && (
            <div style={{
              position: 'absolute', top: '60px', left: '15px', zIndex: 1001,
              background: 'rgba(8,8,10,0.95)', border: '1px solid #ff8c00',
              padding: '14px', maxWidth: '240px', borderRadius: '4px',
              backdropFilter: 'blur(12px)', boxShadow: '0 0 20px rgba(255,140,0,0.2)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ color: '#ff8c00', fontSize: '11px', letterSpacing: '1px' }}>📋 DISTRICT_INTEL</span>
                <span onClick={() => setShowDossier(false)} style={{ cursor: 'pointer', color: '#555', fontSize: '14px' }}>✕</span>
              </div>
              <div style={{ fontSize: '12px', color: '#fff', fontWeight: 'bold' }}>{dossier.district || searchQuery}</div>
              <div style={{ fontSize: '10px', color: '#666', marginBottom: '8px' }}>{dossier.state || ''}</div>

              <div style={{ fontSize: '10px', color: '#888' }}>SAFETY_SCORE</div>
              <div style={{ fontSize: '20px', color: dossier.safetyScore > 6 ? '#39ff14' : dossier.safetyScore > 4 ? '#ffff00' : '#ff1a1a', fontWeight: 'bold' }}>
                {dossier.safetyScore || 'N/A'} / 10
              </div>

              {dossier.topThreats && (
                <div style={{ marginTop: '8px' }}>
                  <div style={{ fontSize: '9px', color: '#555', letterSpacing: '1px' }}>TOP_THREATS</div>
                  {dossier.topThreats.map((t, i) => (
                    <div key={i} style={{ fontSize: '10px', color: '#ff8c00', paddingLeft: '8px' }}>▸ {t}</div>
                  ))}
                </div>
              )}

              {dossier.timeRisk && (
                <div style={{ marginTop: '8px', borderTop: '1px solid #1a1a1a', paddingTop: '6px' }}>
                  <div style={{ fontSize: '9px', color: '#555' }}>TIME_RISK</div>
                  <div style={{ fontSize: '10px', color: '#ffaa44' }}>{dossier.timeRisk.current}</div>
                  <div style={{ fontSize: '9px', color: '#666' }}>{dossier.timeRisk.prediction}</div>
                </div>
              )}
            </div>
          )}

          {/* ── REPORT INTEL PANEL ──────────────────────────── */}
          {reportMode && (
            <div style={{
              position: 'absolute', top: '60px', right: '15px', zIndex: 1001,
              background: 'rgba(8,8,10,0.95)', border: '1px solid #ff8c00',
              padding: '14px', width: '240px', borderRadius: '4px', backdropFilter: 'blur(12px)'
            }}>
              <div style={{ color: '#ff8c00', fontSize: '11px', marginBottom: '10px' }}>📡 SUBMIT_FIELD_INTEL</div>
              <textarea
                value={reportDesc}
                onChange={e => setReportDesc(e.target.value)}
                placeholder="Describe suspicious activity..."
                rows={3}
                style={{
                  width: '100%', background: '#111', border: '1px solid #333',
                  color: '#ddd', fontFamily: 'monospace', fontSize: '11px',
                  padding: '8px', resize: 'none', outline: 'none', boxSizing: 'border-box', borderRadius: '3px'
                }}
              />
              <div style={{ marginTop: '8px', fontSize: '10px', color: '#555' }}>
                LOC: {userPos ? `${userPos[0].toFixed(4)}, ${userPos[1].toFixed(4)}` : 'AWAITING_GPS'}
              </div>
              <button
                onClick={submitReport}
                style={{
                  marginTop: '8px', width: '100%', background: '#ff8c00', color: '#000',
                  border: 'none', padding: '8px', cursor: 'pointer', fontFamily: 'monospace',
                  fontWeight: 'bold', fontSize: '11px', borderRadius: '3px'
                }}
              >
                TRANSMIT_INTEL
              </button>
            </div>
          )}

          {/* ── ADMIN COMMANDER PANEL ───────────────────────── */}
          {showAdminPanel && (
            <div style={{
              position: 'absolute', top: '60px', left: '50%', transform: 'translateX(-50%)',
              zIndex: 1001, background: 'rgba(4,8,20,0.97)', border: '1px solid #4488ff',
              padding: '16px', width: '340px', borderRadius: '4px',
              backdropFilter: 'blur(16px)', boxShadow: '0 0 30px rgba(68,136,255,0.25)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                <span style={{ color: '#4488ff', fontSize: '12px', letterSpacing: '1px' }}>⚡ COMMANDER_DASHBOARD</span>
                <span onClick={() => setShowAdminPanel(false)} style={{ cursor: 'pointer', color: '#555' }}>✕</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
                {[
                  { label: 'ACTIVE SOS', val: activeSOS.length, col: '#ff1a1a' },
                  { label: 'GRID NODES', val: data.length, col: '#39ff14' },
                  { label: 'ALERT LVL', val: alertLevel, col: alert.color },
                  { label: 'OFFLINE', val: offlineReady ? 'YES' : 'NO', col: offlineReady ? '#39ff14' : '#555' },
                ].map((s, i) => (
                  <div key={i} style={{
                    background: 'rgba(255,255,255,0.03)', border: '1px solid #1a1a2e',
                    padding: '8px', borderRadius: '3px', textAlign: 'center'
                  }}>
                    <div style={{ fontSize: '9px', color: '#555' }}>{s.label}</div>
                    <div style={{ fontSize: '18px', color: s.col, fontWeight: 'bold' }}>{s.val}</div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: '10px', color: '#555', marginBottom: '6px' }}>LIVE SOS SIGNALS</div>
              {activeSOS.length === 0 ? (
                <div style={{ fontSize: '10px', color: '#333', textAlign: 'center', padding: '10px' }}>NO_ACTIVE_DISTRESS_SIGNALS</div>
              ) : activeSOS.slice(-5).map((s, i) => (
                <div key={i} style={{
                  background: 'rgba(255,26,26,0.08)', border: '1px solid #2a0a0a',
                  padding: '6px 8px', borderRadius: '3px', marginBottom: '4px', fontSize: '10px'
                }}>
                  <span style={{ color: '#ff4444' }}>🚨 {s.userId}</span>
                  <span style={{ color: '#555', marginLeft: '8px' }}>{s.lat?.toFixed(3)}, {s.lng?.toFixed(3)}</span>
                  <span style={{ color: '#333', float: 'right' }}>{new Date(s.time).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}

        </div>
      )}

      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes hudPulse {
          0%,100% { box-shadow: 0 0 10px ${alert.glow}; }
          50%      { box-shadow: 0 0 25px ${alert.glow}, 0 0 50px ${alert.glow}; }
        }
        @keyframes sosFlash {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.6; }
        }
        @keyframes slideIn {
          from { opacity:0; transform: translateX(20px); }
          to   { opacity:1; transform: translateX(0); }
        }
        /* ── KILL ALL ROUTING NOISE ── */
        .leaflet-routing-container,
        .leaflet-routing-alt,
        .leaflet-routing-geocoders,
        .leaflet-bar.leaflet-control.leaflet-routing-container {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          width: 0 !important;
          height: 0 !important;
          pointer-events: none !important;
          overflow: hidden !important;
        }
        /* ── POPUPS ── */
        .custom-popup .leaflet-popup-content-wrapper {
          background: #0a0a0b !important;
          border: 1px solid #ff3131 !important;
          border-radius: 0 !important;
          box-shadow: 0 0 15px rgba(255,49,49,0.4) !important;
          color: #fff !important;
        }
        .custom-popup .leaflet-popup-tip { background: #ff3131 !important; }
        .custom-popup-inner {
          font-family: monospace;
          font-size: 11px;
          color: #ddd;
          line-height: 1.6;
        }
        /* ── HEATMAP CANVAS ── */
        .leaflet-heatmap-layer {
          opacity: 1 !important;
          z-index: 500 !important;
          pointer-events: none !important;
        }
        .leaflet-container { background: #000 !important; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0b; }
        ::-webkit-scrollbar-thumb { background: #222; }
      `}</style>
    </div>
  );
}

export default App;

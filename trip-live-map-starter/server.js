import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: '*' } });

// ======= In-memory store (demo) =======
const trips = new Map(); // join_code -> trip

(function seed(){
  const tripId = randomUUID();
  const join_code = 'demo1234';
  // Center around Khao Yai area (approximate)
  trips.set(join_code, {
    id: tripId,
    join_code,
    name: 'ทริปเขาใหญ่ วันเดียว',
    center: { lat: 14.705, lng: 101.417, zoom: 10 },
    schedule: [
      // Example schedule from the user's idea (dates use ISO; times local users will see formatted in UI)
      {
        id: randomUUID(),
        title: 'แวะหาร้านข้าวเช้าระหว่างทาง',
        time_start: '2025-11-01T09:30:00.000Z',
        notes: '🚌 เสาร์ 1 พ.ย. 2568 (ไปทางสระบุรี)',
        gmaps_url: '',
        lat: null, lng: null
      },
      {
        id: randomUUID(),
        title: 'ถึง ไร่องุ่น PB Valley 🍇 + ร่วมทัวร์ชม + อาหารไทย/ยุโรป',
        time_start: '2025-11-01T10:40:00.000Z',
        notes: 'บรรยากาศกลางไร่องุ่น',
        gmaps_url: 'https://maps.app.goo.gl/d73mcde5uVFwGU3U7',
        lat: null, lng: null
      },
      {
        id: randomUUID(),
        title: 'ทานอาหารกลางวัน',
        time_start: '2025-11-01T12:30:00.000Z',
        notes: '',
        gmaps_url: '',
        lat: null, lng: null
      },
      {
        id: randomUUID(),
        title: 'Primo Piazza + ฟาร์มแกะ สไตล์อิตาลี',
        time_start: '2025-11-01T13:30:00.000Z',
        notes: 'คาเฟ่ + จุดถ่ายรูป',
        gmaps_url: 'https://maps.app.goo.gl/KjZFhHH7QngMrjKs7',
        lat: null, lng: null
      },
      {
        id: randomUUID(),
        title: 'เช็คอิน The One Hundred Pool Villa Khaoyai 🏡',
        time_start: '2025-11-01T14:00:00.000Z',
        notes: '',
        gmaps_url: '',
        lat: null, lng: null
      }
    ],
    vehicles: [],
    chat: [] // {name,text,ts}
  });
})();

// ======= REST =======
app.post('/api/trips', (req, res)=>{
  const id = randomUUID();
  const join_code = Math.random().toString(36).slice(2,8);
  const trip = {
    id, join_code,
    name: req.body?.name || 'My Trip',
    center: req.body?.center || { lat: 13.736, lng: 100.523, zoom: 6 },
    schedule: [], vehicles: [], chat: []
  };
  trips.set(join_code, trip);
  res.json({ id, join_code });
});

app.get('/api/trips/:join', (req, res)=>{
  const trip = trips.get(req.params.join);
  if (!trip) return res.status(404).json({ error: 'not found' });
  res.json(trip);
});

app.post('/api/trips/:id/vehicles', (req, res)=>{
  const { id } = req.params; const name = req.body?.name || 'Vehicle';
  const trip = [...trips.values()].find(t=>t.id===id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  const vehicle = { id: randomUUID(), name };
  trip.vehicles.push(vehicle);
  res.json({ vehicle_id: vehicle.id });
});

// Add schedule item (with optional Google Maps link and coordinates)
app.post('/api/trips/:id/schedule', (req, res)=>{
  const { id } = req.params;
  const { title, time_start, time_end, lat, lng, notes, gmaps_url } = req.body || {};
  const trip = [...trips.values()].find(t=>t.id===id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  if (!title || !time_start) return res.status(400).json({ error: 'title/time_start required' });
  const item = {
    id: randomUUID(), title, time_start,
    time_end: time_end || null, lat: lat ?? null, lng: lng ?? null,
    notes: notes || '', gmaps_url: gmaps_url || ''
  };
  trip.schedule.push(item);
  const room = `room:trip:${trip.id}`;
  io.to(room).emit('scheduleUp', trip.schedule);
  res.json({ ok: true, item });
});

// ======= WebSocket =======
io.on('connection', (socket)=>{
  socket.on('joinTrip', ({ tripId, vehicleId })=>{
    const trip = [...trips.values()].find(t=>t.id===tripId);
    if (!trip) return;
    const room = `room:trip:${tripId}`;
    socket.join(room);
    // immediate snapshots
    io.to(room).emit('vehicles', trip.vehicles);
    io.to(room).emit('scheduleUp', trip.schedule);
  });

  socket.on('locUpdate', ({ tripId, vehicleId, lat, lng, speedKmh, heading, ts })=>{
    const trip = [...trips.values()].find(t=>t.id===tripId);
    if (!trip) return;
    const veh = trip.vehicles.find(v=>v.id===vehicleId);
    if (!veh) return;
    Object.assign(veh, {
      last_lat: lat, last_lng: lng,
      last_speed_kmh: speedKmh, last_heading: heading,
      updated_at: ts || Date.now()
    });
    const room = `room:trip:${tripId}`;
    io.to(room).emit('vehicles', trip.vehicles);
  });

  // Simple room chat
  socket.on('chat:join', ({ tripId, name })=>{
    const trip = [...trips.values()].find(t=>t.id===tripId); if (!trip) return;
    const room = `room:trip:${tripId}`; socket.join(room);
    socket.data.chatName = name || 'Guest'; socket.data.tripId = tripId;
    socket.emit('chat:joined', {});
  });

  socket.on('chat:leave', ({ tripId })=>{
    const room = `room:trip:${tripId}`; socket.leave(room); socket.emit('chat:left', {});
  });

  socket.on('chat:msg', ({ tripId, text })=>{
    const trip = [...trips.values()].find(t=>t.id===tripId); if (!trip) return;
    const room = `room:trip:${tripId}`;
    const msg = {
      name: socket.data.chatName || 'Guest',
      text: (text||'').toString().slice(0,1000),
      ts: Date.now()
    };
    trip.chat.push(msg); if (trip.chat.length > 500) trip.chat.shift();
    io.to(room).emit('chat:msg', msg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('Server on http://localhost:'+PORT));
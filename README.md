# 🎥 Zoom Lite Offline

Aplikasi video meeting lokal yang berjalan di jaringan hotspot **tanpa internet**. Seperti Zoom, tapi offline!

## ✨ Fitur

| Fitur | Host | Participant |
|-------|------|-------------|
| 📹 Camera | ✅ | ✅ |
| 🎤 Microphone | ✅ | ✅ |
| 🖥️ Screen Share | ✅ | ✅ |
| 🎬 Recording | ✅ | ❌ |

- **Recording**: Host dapat merekam semua participant (video + audio + screen share)
- **Format**: WebM 
- **Tanpa Internet**: Berjalan di jaringan lokal (hotspot)

---

## 🚀 Quick Start

### 1. Install Bun

```powershell
# Windows (PowerShell as Admin)
powershell -c "irm bun.sh/install.ps1 | iex"

# Atau via npm
npm install -g bun
```

### 2. Jalankan Server

```powershell
cd d:\Documents\GitHub\local_webrtc
bun run dev
```

Server akan menampilkan:
```
╔════════════════════════════════════════════════════════════╗
║           🎥 Zoom Lite Offline - Server Started            ║
╠════════════════════════════════════════════════════════════╣
║  Local:    http://localhost:3000                           ║
║  Network:  http://192.168.x.x:3000                         ║
╚════════════════════════════════════════════════════════════╝
```

---

## 📱 Cara Penggunaan

### Setup Jaringan

1. **HP**: Aktifkan **Hotspot** (tidak perlu internet)
2. **Laptop**: Koneksikan ke hotspot HP
3. **Participant**: Koneksikan ke hotspot yang sama

### Host (Laptop)

1. Buka browser: `http://localhost:3000`
2. Masukkan nama → Klik **Create Meeting**
3. Catat **Room ID** (contoh: `ABC123`)
4. Bagikan Room ID ke participant

### Participant (HP/Device lain)

1. Buka browser di HP/tablet
2. Akses: `http://[IP-LAPTOP]:3000`
   - IP laptop terlihat di console server
   - Contoh: `http://192.168.43.100:3000`
3. Masukkan nama → Masukkan Room ID → Klik **Join Meeting**

---

## 🎬 Recording

Recording hanya tersedia untuk **Host**:

1. Klik tombol **Record** (bulatan merah)
2. Semua video + audio participant akan direkam
3. Klik lagi untuk **Stop**
4. File `.webm` otomatis terdownload


## ⚙️ Troubleshooting

### "Cannot access camera/microphone"

- Pastikan browser memiliki izin akses kamera/mic
- Di Chrome: Settings → Privacy → Site Settings → Camera/Microphone

### "Connection failed"

- Pastikan semua device di jaringan yang sama
- Cek firewall Windows tidak memblokir port 3000:
  ```powershell
  # Run as Admin
  netsh advfirewall firewall add rule name="Zoom Lite" dir=in action=allow protocol=TCP localport=3000
  ```

### "Room not found"

- Pastikan Room ID benar (case-sensitive)
- Pastikan Host masih aktif di meeting

---

## 🔧 Development

```powershell
# Install dependencies
bun install

# Run development server
bun run dev

# Type check
bun run tsc --noEmit
```

---

## 📁 Struktur Project

```
local-webrtc/
├─ server/
│  └─ server.ts      # Bun HTTP + WebSocket server
├─ public/
│  ├─ index.html     # UI layout
│  ├─ main.js        # WebRTC + Recording logic
│  └─ style.css      # Modern dark theme
├─ package.json
└─ README.md
```

---

## 📋 System Requirements

- **Server**: Windows/Mac/Linux dengan Bun runtime
- **Client**: Browser modern (Chrome, Firefox, Edge, Safari)
- **Network**: Local network (WiFi hotspot)

---

Made with ❤️ for offline meetings

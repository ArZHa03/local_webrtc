/**
 * Zoom Lite Offline - Signaling Server
 * Bun HTTP + WebSocket server for WebRTC signaling
 */

import { serve, file } from "bun";
import { join } from "path";

const PORT = 3000;
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

// Room management
interface Participant {
  id: string;
  name: string;
  ws: WebSocket;
  isHost: boolean;
}

interface Room {
  id: string;
  host: Participant | null;
  participants: Map<string, Participant>;
}

const rooms = new Map<string, Room>();

// Generate random room ID
function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Generate participant ID
function generateParticipantId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// Get local IP addresses
function getLocalIPs(): string[] {
  const interfaces = require("os").networkInterfaces();
  const ips: string[] = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// Broadcast to all participants in a room except sender
function broadcast(room: Room, message: object, excludeId?: string) {
  const data = JSON.stringify(message);
  room.participants.forEach((participant) => {
    if (participant.id !== excludeId && participant.ws.readyState === WebSocket.OPEN) {
      participant.ws.send(data);
    }
  });
}

// Send to specific participant
function sendTo(room: Room, targetId: string, message: object) {
  const participant = room.participants.get(targetId);
  if (participant && participant.ws.readyState === WebSocket.OPEN) {
    participant.ws.send(JSON.stringify(message));
  }
}

const server = serve({
  port: PORT,

  tls: {
    key: file(join(import.meta.dir, "..", "certs", "server.key")),
    cert: file(join(import.meta.dir, "..", "certs", "server.crt")),
  },

  async fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Serve static files
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = join(PUBLIC_DIR, filePath);

    try {
      const fileContent = file(fullPath);
      if (await fileContent.exists()) {
        return new Response(fileContent);
      }
    } catch (e) {
      // File not found
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      // @ts-ignore
      ws.participantId = generateParticipantId();
    },

    message(ws, message) {
      try {
        const data = JSON.parse(message.toString());
        // @ts-ignore
        const participantId = ws.participantId as string;

        switch (data.type) {
          case "create-room": {
            const roomId = generateRoomId();
            const participant: Participant = {
              id: participantId,
              name: data.name || "Host",
              ws: ws as unknown as WebSocket,
              isHost: true,
            };

            const room: Room = {
              id: roomId,
              host: participant,
              participants: new Map([[participantId, participant]]),
            };

            rooms.set(roomId, room);
            // @ts-ignore
            ws.roomId = roomId;

            ws.send(JSON.stringify({
              type: "room-created",
              roomId,
              participantId,
              isHost: true,
            }));

            console.log(`Room ${roomId} created by ${data.name}`);
            break;
          }

          case "join-room": {
            const room = rooms.get(data.roomId);
            if (!room) {
              ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
              return;
            }

            const participant: Participant = {
              id: participantId,
              name: data.name || "Guest",
              ws: ws as unknown as WebSocket,
              isHost: false,
            };

            room.participants.set(participantId, participant);
            // @ts-ignore
            ws.roomId = data.roomId;

            // Send room info to new participant
            const existingParticipants = Array.from(room.participants.values())
              .filter(p => p.id !== participantId)
              .map(p => ({ id: p.id, name: p.name, isHost: p.isHost }));

            ws.send(JSON.stringify({
              type: "room-joined",
              roomId: data.roomId,
              participantId,
              isHost: false,
              participants: existingParticipants,
            }));

            // Notify others about new participant
            broadcast(room, {
              type: "participant-joined",
              participant: { id: participantId, name: data.name, isHost: false },
            }, participantId);

            console.log(`${data.name} joined room ${data.roomId}`);
            break;
          }

          case "offer":
          case "answer":
          case "ice-candidate": {
            // @ts-ignore
            const roomId = ws.roomId as string;
            const room = rooms.get(roomId);
            if (!room) return;

            sendTo(room, data.target, {
              type: data.type,
              from: participantId,
              ...data,
            });
            break;
          }

          case "toggle-media": {
            // @ts-ignore
            const roomId = ws.roomId as string;
            const room = rooms.get(roomId);
            if (!room) return;

            broadcast(room, {
              type: "media-state-changed",
              participantId,
              mediaType: data.mediaType,
              enabled: data.enabled,
            }, participantId);
            break;
          }

          case "start-screen-share":
          case "stop-screen-share": {
            // @ts-ignore
            const roomId = ws.roomId as string;
            const room = rooms.get(roomId);
            if (!room) return;

            broadcast(room, {
              type: data.type,
              participantId,
            }, participantId);
            break;
          }

          case "recording-started":
          case "recording-stopped": {
            // @ts-ignore
            const roomId = ws.roomId as string;
            const room = rooms.get(roomId);
            if (!room) return;

            broadcast(room, {
              type: data.type,
              participantId,
            }, participantId);
            break;
          }
        }
      } catch (e) {
        console.error("Error processing message:", e);
      }
    },

    close(ws) {
      // @ts-ignore
      const roomId = ws.roomId as string;
      // @ts-ignore
      const participantId = ws.participantId as string;

      if (roomId && participantId) {
        const room = rooms.get(roomId);
        if (room) {
          const participant = room.participants.get(participantId);
          room.participants.delete(participantId);

          if (participant?.isHost) {
            // Host left, close room
            broadcast(room, { type: "room-closed" });
            rooms.delete(roomId);
            console.log(`Room ${roomId} closed (host left)`);
          } else {
            // Participant left
            broadcast(room, {
              type: "participant-left",
              participantId,
            });
            console.log(`Participant ${participantId} left room ${roomId}`);
          }
        }
      }
    },
  },
});

// Print server info
console.log("\n╔════════════════════════════════════════════════════════════╗");
console.log("║           🎥 Zoom Lite Offline - Server Started            ║");
console.log("╠════════════════════════════════════════════════════════════╣");
console.log(`║  Local:    https://localhost:${PORT}                          ║`);

const localIPs = getLocalIPs();
localIPs.forEach((ip) => {
  const padding = " ".repeat(Math.max(0, 20 - ip.length));
  console.log(`║  Network:  https://${ip}:${PORT}${padding}            ║`);
});

console.log("╠════════════════════════════════════════════════════════════╣");
console.log("║  1. Buka browser di laptop ini (Host)                      ║");
console.log("║  2. Klik 'Create Meeting' untuk membuat room               ║");
console.log("║  3. Share Room ID ke peserta lain                          ║");
console.log("║  4. Peserta buka https://IP:3000 dan Join dengan Room ID   ║");
console.log("╚════════════════════════════════════════════════════════════╝\n");

# ✋ SignConnect — AI-Based Real-Time Communication Platform
### For Deaf, Mute, and Hearing Users

> **College:** Department of Computer Science & Engineering, AGMRCET, Varur  
> **Project Name:** AccessCall / SignConnect  
> **Tech Stack:** Vanilla JS · Node.js · Socket.IO · WebRTC · MediaPipe · MongoDB Atlas · Cloudflare Tunnel

---

## 📌 Table of Contents

1. [Project Overview](#project-overview)
2. [Features](#features)
3. [System Architecture](#system-architecture)
4. [Project Structure](#project-structure)
5. [Pages & Screens](#pages--screens)
6. [Sign Language Detection](#sign-language-detection)
7. [Video Call System](#video-call-system)
8. [Speech & Subtitles](#speech--subtitles)
9. [Database Design](#database-design)
10. [API Reference](#api-reference)
11. [Socket.IO Events](#socketio-events)
12. [How to Run Locally](#how-to-run-locally)
13. [Deploy with Cloudflare Tunnel](#deploy-with-cloudflare-tunnel)
14. [Environment Variables](#environment-variables)
15. [Supported Gestures](#supported-gestures)
16. [Known Limitations](#known-limitations)

---

## Project Overview

**SignConnect** is a full-stack real-time web application that breaks communication barriers between deaf, mute, and hearing people. It provides:

- Live video calls with **sign language detection** using AI (MediaPipe Hands)
- Detected signs are **spoken aloud** on the remote device (Text-to-Speech)
- Signs appear as **subtitles** on both screens
- **Speech-to-text captions** let deaf users read what hearing people are saying
- Real-time **chat** with sign message support
- Works in any modern browser — no app install needed

---

## Features

| Feature | Description |
|---|---|
| 🤟 Sign → Text | MediaPipe detects 21 hand landmarks and classifies gestures in real time |
| 🔊 Sign → Voice | Detected sign is spoken aloud on the **remote** device via TTS |
| 📝 Sign Subtitles | Sign captions appear on Person B's screen when Person A signs |
| 🎙 Speech → Captions | Person A speaks, captions appear live on Person B's screen |
| 📹 Video Call | Full WebRTC peer-to-peer video call with screen sharing |
| 📞 Incoming Call Alert | Real-time popup notification when someone calls you |
| 💬 Text Chat | Persistent chat with sign message labels stored in MongoDB |
| 👥 Contacts | Add contacts by searching name/username, accept/reject requests |
| 🖥 Screen Sharing | Share your screen during a call |
| 📱 Mobile Ready | Responsive layout works on phones and tablets |
| 🌐 Public Access | Share via Cloudflare Tunnel — no port forwarding needed |

---

## System Architecture

```
Browser (Person A)                    Server (Node.js)              Browser (Person B)
─────────────────                    ─────────────────              ─────────────────
MediaPipe detects sign
        │
        ▼
socket.emit('sign_caption')  ──────► server relays ──────────────► socket.on('sign_caption')
                                                                            │
                                                                     Show subtitle +
                                                                     Speak via TTS
                                                                     on Person B's device

WebRTC Video/Audio  ◄──────────────── STUN/TURN ──────────────────► WebRTC Video/Audio
                    (peer-to-peer, server only does signaling)

Socket.IO Signaling ◄──────────────── server.js ──────────────────► Socket.IO Signaling
   (offer/answer/ICE)               (relay only)                    (offer/answer/ICE)

MongoDB Atlas  ◄──── Users / Contacts / Messages stored here
```

---

## Project Structure

```
sign_call/
│
├── index.html          ← Landing page (login/register)
├── app.html            ← Main chat page (contacts + messages)
├── call.html           ← Video call page (WebRTC + sign detection)
├── styles.css          ← App-level styles
│
├── css/
│   ├── main.css        ← Design system (colors, typography, components)
│   ├── landing.css     ← Landing page styles
│   ├── app.css         ← Chat app styles
│   └── call.css        ← Video call page styles
│
├── js/
│   ├── api.js          ← HTTP API client (fetch wrapper, auth, contacts, messages)
│   ├── ui.js           ← UI helpers (toasts, modals, debounce, emoji, skeleton)
│   ├── app.js          ← Chat app logic (contacts, messages, sign panel, socket)
│   ├── call.js         ← WebRTC call logic (signaling, sign detection, speech)
│   ├── mediapipe.js    ← GestureEngine (25+ gestures, landmark math, drawing)
│   ├── speech.js       ← SpeechEngine (STT via Web Speech API, TTS)
│   └── landing.js      ← Landing page (auth modal, login/register forms)
│
└── server/
    ├── server.js       ← Express + Socket.IO + MongoDB backend
    ├── package.json    ← Node.js dependencies
    └── .env            ← Environment variables (MongoDB URI, JWT secret)
```

---

## Pages & Screens

### `index.html` — Landing Page
- Hero section with animated demo
- Feature cards explaining the system
- Login / Register modal with user type selection (Deaf / Mute / Deaf+Mute / Hearing)
- JWT token stored in `localStorage` after login

### `app.html` — Chat Page
- Left sidebar: contact list with online/offline status
- Add contact modal with user search
- Chat messages panel with text and sign messages
- Sign language panel (open camera → detect gestures → queue words → send as message)
- Incoming call notification banner (real-time via Socket.IO)
- Click 📹 call button → emits `call:ring` to notify recipient, then navigates to `call.html`

### `call.html` — Video Call Page
- Full-screen remote video (`object-fit: contain` — no zoom)
- Local video PiP (draggable, resizable) — bottom-right corner
- Hand skeleton overlay drawn on local video canvas
- Top bar: contact name, call duration, connection quality
- Controls bar: Mic | Camera | Signs 🤟 | Captions | Speech | History | Screen Share | End
- Sign caption bubbles appear over remote video
- Caption bar shows speech-to-text and sign captions at bottom

---

## Sign Language Detection

**File:** `js/mediapipe.js` + `js/call.js`

### How it works:
1. MediaPipe Hands loads from CDN, tracks **21 landmarks** per hand
2. Each frame is processed by `GestureEngine.processFrame(landmarks)`
3. The engine calculates finger extension, thumb direction, and inter-landmark distances
4. A **temporal buffer** of 8 frames ensures stability (no flickering)
5. A gesture must hold for **12 frames** before emitting (prevents false positives)
6. **1800ms cooldown** prevents the same gesture from spamming

### Detection Loop (laptop + mobile compatible):
```js
// Uses requestAnimationFrame — NOT Camera utility
// Works correctly with WebRTC streams on all devices
const detectLoop = async () => {
  if (localVideo.readyState >= 2) {
    await handsInstance.send({ image: localVideo });
  }
  setTimeout(() => requestAnimationFrame(detectLoop), 66); // ~15fps
};
```

### When a gesture is confirmed (Person A's device):
1. Caption entry added locally ("You: Hello")
2. `socket.emit('sign_caption', { roomId, gesture, confidence, userName })`
3. **NO TTS on Person A's device**

### When sign_caption received (Person B's device):
1. Animated sign bubble appears over remote video
2. Sign shown in caption bar: `✋ Hello`
3. `SpeechEngine.speak('Hello')` — spoken aloud on Person B's device
4. Added to caption history panel

---

## Video Call System

**File:** `js/call.js`, `server/server.js`

### Call Flow:
```
Person A clicks 📹 Call
    ↓
socket.emit('call:ring')  →  Server  →  socket.emit('call:incoming') to Person B
    ↓
Person A navigates to call.html
    ↓
Person B sees incoming call banner  →  clicks Accept
    ↓
Person B navigates to call.html
    ↓
Both join same room via socket.emit('join-room', { roomId })
    ↓
Server sends room-peers list to first joiner
    ↓
Initiator creates RTCPeerConnection → createOffer → sends via webrtc-offer
    ↓
Receiver gets offer → createAnswer → sends via webrtc-answer
    ↓
ICE candidates exchanged via webrtc-ice
    ↓
WebRTC P2P connection established → video/audio flows directly
```

### STUN/TURN:
- Uses Google STUN servers (`stun.l.google.com:19302`)
- For production, add TURN credentials in `ICE_SERVERS` in `call.js`

---

## Speech & Subtitles

**File:** `js/speech.js`

| Direction | Technology | What happens |
|---|---|---|
| Person A signs → Person B hears | MediaPipe + Socket.IO + TTS | Sign detected → sent via socket → spoken on B's device |
| Person A speaks → Person B reads | Web Speech API STT + Socket.IO | Voice transcribed → sent via socket → shown as caption on B's screen |
| Sign shown on screen | Socket.IO + DOM | Bubble animation + caption bar update on receiver's screen |

### TTS Mobile Fix:
- Audio context unlocked on first `touchstart` or `click`
- Voices reloaded if list is empty (async loading on mobile)
- Silent utterance played on page load to pre-warm TTS engine

---

## Database Design

**MongoDB Atlas** — Database: `sign_call`

### Users Collection
```js
{
  name:        String,   // Display name
  email:       String,   // Unique, lowercase
  username:    String,   // Unique, lowercase
  password:    String,   // bcrypt hashed (select: false)
  userType:    String,   // 'deaf' | 'mute' | 'deafmute' | 'hearing'
  avatarColor: String,   // Hex color for avatar
  bio:         String,
  isOnline:    Boolean,
  lastSeen:    Date,
  createdAt:   Date
}
```

### Contacts Collection
```js
{
  userId:    ObjectId,   // Who owns this contact
  contactId: ObjectId,   // The contact
  addedAt:   Date
}
// Index: { userId, contactId } unique — bidirectional (both sides stored)
```

### Messages Collection
```js
{
  conversationId: String,   // sorted(userId1, userId2).join(':')
  from:      ObjectId,
  to:        ObjectId,
  content:   String,
  type:      String,        // 'text' | 'sign' | 'voice'
  signLabel: String,        // e.g. "ASL: Hello, Thank You"
  read:      Boolean,
  timestamp: Date
}
```

---

## API Reference

**Base URL:** `http://localhost:5001` (or Cloudflare tunnel URL)

### Auth
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/signup` | Register new user |
| POST | `/api/auth/login` | Login, returns JWT token |
| GET | `/api/auth/me` | Get current user (requires token) |
| PATCH | `/api/auth/profile` | Update name/bio |

### Users
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/users/search?q=` | Search users by name/username/email |
| GET | `/api/users/:id` | Get user by ID |

### Contacts
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/contacts` | Get all contacts of current user |
| POST | `/api/contacts` | Add contact `{ contactId }` (bidirectional) |
| DELETE | `/api/contacts/:contactId` | Remove contact |

### Messages
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/messages/:contactId` | Get conversation history |
| POST | `/api/messages` | Send message `{ toId, content, type, signLabel }` |
| GET | `/api/messages/unread/count` | Get unread count |

### Health
| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Server + MongoDB status |

---

## Socket.IO Events

### Client → Server
| Event | Payload | Description |
|---|---|---|
| `join-room` | `{ roomId }` | Join a call room |
| `call:ring` | `{ contactId, roomId, callerName, callMode }` | Notify someone of incoming call |
| `call:reject` | `{ contactId, roomId }` | Reject a call |
| `webrtc-offer` | `{ targetSocketId, sdp }` | Send WebRTC offer |
| `webrtc-answer` | `{ targetSocketId, sdp }` | Send WebRTC answer |
| `webrtc-ice` | `{ targetSocketId, candidate }` | Send ICE candidate |
| `sign_caption` | `{ roomId, gesture, confidence, userName }` | Send detected sign |
| `speech_caption` | `{ roomId, text, isFinal, userName }` | Send speech transcript |
| `call_control` | `{ roomId, type, value, userName }` | Mic/camera toggle notify |
| `screen_share` | `{ roomId, active, userName }` | Screen share status |
| `call_end` | `{ roomId }` | End the call |
| `typing` | `{ toUserId, isTyping }` | Typing indicator |

### Server → Client
| Event | Payload | Description |
|---|---|---|
| `call:incoming` | `{ roomId, callMode, caller }` | Incoming call notification |
| `call:rejected` | `{ roomId }` | Call was rejected |
| `room-peers` | `{ peers[] }` | List of peers already in room |
| `peer-joined` | `{ socketId, userId, userName }` | Someone joined the room |
| `peer-left` | `{ socketId, userName }` | Someone left the room |
| `webrtc-offer` | `{ sdp, fromSocketId, fromUserName }` | Relay offer |
| `webrtc-answer` | `{ sdp, fromSocketId }` | Relay answer |
| `webrtc-ice` | `{ candidate, fromSocketId }` | Relay ICE candidate |
| `sign_caption` | `{ gesture, confidence, userName }` | Remote sign detected |
| `speech_caption` | `{ text, isFinal, userName }` | Remote speech transcript |
| `presence` | `{ userId, isOnline, lastSeen }` | Contact online status |
| `new_message` | message object | New chat message received |
| `typing` | `{ fromUserId, fromName, isTyping }` | Typing indicator |
| `call_ended` | — | Remote ended the call |

---

## How to Run Locally

### Prerequisites
- Node.js 18+
- MongoDB Atlas account (free tier) OR local MongoDB

### Steps

```bash
# 1. Clone / download the project
cd "sign_call"

# 2. Install server dependencies
cd server
npm install

# 3. Create .env file
cp .env.example .env
# Edit .env — set MONGODB_URI and JWT_SECRET

# 4. Start the server
node server.js

# 5. Open browser
# http://localhost:5001
```

The server serves the frontend **directly** — no separate build step needed.

---

## Deploy with Cloudflare Tunnel

Share your local server with anyone on the internet (no port forwarding):

```bash
# Install cloudflared
winget install cloudflare.cloudflared

# Start tunnel (in a separate terminal)
cloudflared tunnel --url http://localhost:5001
```

You get a URL like: `https://xyz-abc.trycloudflare.com`  
Share this URL — friends can open it and call you directly.

---

## Environment Variables

**File:** `server/.env`

```env
# MongoDB Atlas connection string
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/sign_call

# JWT secret — long random string
JWT_SECRET=your_secret_here_min_32_chars

# Token expiry
JWT_EXPIRES_IN=7d

# Server port
PORT=5001

# Environment
NODE_ENV=production
```

---

## Supported Gestures

| Gesture | Sign | Description |
|---|---|---|
| Hello | 👋 | Open palm, all fingers spread |
| I Love You | 🤟 | Thumb + index + pinky extended |
| Yes | ✊ | Closed fist |
| No | ☝️ | Index finger pointing up |
| Stop | ✋ | Flat hand, four fingers together |
| Good | 👍 | Thumb up |
| Bad | 👎 | Thumb down |
| Help | 🤝 | Thumb + index L-shape |
| Peace | ✌️ | Index + middle (V sign) |
| Sorry | 🤜 | Closed fist (circular motion context) |
| Thank You | 🙏 | Flat hand near chin height |
| Water | 💧 | Ring + middle + index extended |
| Home | 🏠 | All fingers up, hand high |
| Who | 🤔 | Index hooked/bent |
| Where | 👉 | Index pointing sideways |
| Eat | 🍽 | Fingertips bunched together |
| A–F, L, O, Y | — | ASL alphabet letters |

---

## Known Limitations

| Issue | Notes |
|---|---|
| WebRTC behind strict NAT | Add TURN server credentials in `call.js` `ICE_SERVERS` for guaranteed connectivity |
| Sign detection accuracy | Based on finger geometry — lighting and hand angle affect accuracy |
| Speech recognition | Web Speech API requires Chrome/Edge browser; not available in Firefox |
| Mobile TTS | Requires one user gesture to unlock audio on iOS (auto-handled) |
| Cloudflare tunnel URL | Changes every restart — share new URL each session |
| Scale | Single server, in-memory room tracking — not suitable for 1000+ concurrent calls |

---

## Credits

Built for the **Department of CSE, AGMRCET, Varur** as a major project.

**Technologies used:**
- [MediaPipe Hands](https://mediapipe.dev/) — Hand landmark detection
- [Socket.IO](https://socket.io/) — Real-time bidirectional communication
- [WebRTC](https://webrtc.org/) — Peer-to-peer video/audio
- [MongoDB Atlas](https://www.mongodb.com/atlas) — Cloud database
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) — Public URL tunneling
- [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) — STT & TTS

---

*"Sign language is a language — we make it universal."*

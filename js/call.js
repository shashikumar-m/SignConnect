/**
 * SignConnect — Video Call Logic (Production WebRTC)
 * call.js
 *
 * Real peer-to-peer video call using:
 *  - Socket.io  → signaling (SDP offer/answer + ICE candidates)
 *  - WebRTC RTCPeerConnection → live audio/video between browsers
 *  - MediaPipe Hands → real-time sign detection on local video
 *  - Web Speech API  → speech-to-text captions
 *  - Socket.io events → relay sign captions & speech to remote peer
 *
 * URL params:
 *   ?cid=<contactId>&mode=video|voice
 */
(async function () {
  'use strict';

  // ── Auth guard — fetch real user from server ───────────────
  if (!API.isLoggedIn()) { window.location.href = 'index.html'; return; }

  let currentUser;
  try {
    currentUser = await API.Auth.me();
  } catch {
    API.Auth.logout();
    return;
  }

  // ── URL params ─────────────────────────────────────────────
  const params    = new URLSearchParams(location.search);
  const contactId = params.get('cid');
  const callMode  = params.get('mode') || 'video';

  if (!contactId) { window.location.href = 'app.html'; return; }
  const contact = await API.Users.getById(contactId);
  if (!contact)  { window.location.href = 'app.html'; return; }

  // ── Room ID = sorted user IDs joined (same as Messages convId) ──
  const roomId = [(currentUser._id||currentUser.id), contactId].sort().join(':');
  // ── STUN/TURN config ───────────────────────────────────────
  // Google's free STUN works for most networks.
  // Add TURN credentials here for users behind strict firewalls.
  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      // Add TURN server here for full NAT traversal:
      // { urls: 'turn:YOUR_TURN_SERVER', username: 'user', credential: 'pass' }
    ],
    iceCandidatePoolSize: 10,
  };

  // ── DOM refs ───────────────────────────────────────────────
  const $  = id => document.getElementById(id);
  const localVideo          = $('localVideo');
  const localCanvas         = $('localCanvas');
  const remoteVideo         = $('remoteVideo');
  const remotePlaceholder   = $('remotePlaceholder');
  const remotePlaceholderAvatar = $('remotePlaceholderAvatar');
  const remotePlaceholderName   = $('remotePlaceholderName');
  const captionBar          = $('captionBar');
  const captionInterim      = $('captionInterim');
  const captionFinal        = $('captionFinal');
  const signCaptionArea     = $('signCaptionArea');
  const captionList         = $('captionList');
  const captionHistory      = $('captionHistory');
  const callDuration        = $('callDuration');
  const callContactName     = $('callContactName');
  const callContactAvatar   = $('callContactAvatar');
  const localVideoWrap      = $('localVideoWrap');
  const localVideoName      = $('localVideoName');
  const localSignLabel      = $('localSignLabel');
  const callConfFill        = $('callConfFill');
  const callConfPct         = $('callConfPct');
  const callConfidence      = $('callConfidence');
  const controlsBar         = $('controlsBar');
  const callTopbar          = $('callTopbar');
  const remoteStatusEl      = $('callContactStatus');

  // ── Application state ──────────────────────────────────────
  const state = {
    localStream:      null,
    remoteStream:     null,
    peerConn:         null,     // RTCPeerConnection
    socket:           null,     // Socket.io connection
    remoteSocketId:   null,     // socket ID of the remote peer
    isInitiator:      false,    // did we create the offer?
    connected:        false,    // is WebRTC connected?
    localMic:         true,
    localCam:         callMode !== 'voice',
    signDetectOn:     true,
    captionsOn:       true,
    speechOn:         false,
    screenSharing:    false,
    screenStream:     null,
    callSeconds:      0,
    callTimer:        null,
    handsInstance:    null,
    cameraUtil:       null,
    controlsHideTimer:null,
    reconnectAttempts:0,
    maxReconnect:     3,
  };

  // ── Init contact UI ────────────────────────────────────────
  callContactName.textContent         = contact.name;
  callContactAvatar.textContent       = UI.Format.initials(contact.name);
  callContactAvatar.style.background  = contact.avatarColor || 'var(--color-primary)';
  remotePlaceholderAvatar.textContent = UI.Format.initials(contact.name);
  remotePlaceholderAvatar.style.background = contact.avatarColor || 'var(--color-primary)';
  remotePlaceholderName.textContent   = contact.name;
  localVideoName.textContent          = currentUser.name;

  setRemoteStatus('Connecting…');

  // ══════════════════════════════════════════════════════════
  //  STEP 1 — Get local camera/mic
  // ══════════════════════════════════════════════════════════
  async function initLocalStream() {
    try {
      const constraints = {
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
        video: (callMode === 'voice') ? false : {
          width:  { ideal: 1280 }, height: { ideal: 720 },
          facingMode: 'user', frameRate: { ideal: 30 },
        },
      };
      state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      localVideo.srcObject = state.localStream;

      localVideo.addEventListener('loadedmetadata', () => {
        localCanvas.width  = localVideo.videoWidth  || 640;
        localCanvas.height = localVideo.videoHeight || 480;
      }, { once: true });

      if (callMode === 'voice') {
        state.localCam = false;
        $('ctrlCam').classList.add('disabled-cam');
        $('ctrlCam').setAttribute('aria-pressed', 'false');
      }

      connectSignalingServer();
    } catch (err) {
      UI.Toast.error('Camera/mic access denied: ' + err.message);
      // Try audio-only fallback
      try {
        state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        state.localCam = false;
        connectSignalingServer();
      } catch {
        UI.Toast.error('Could not access microphone. Check browser permissions.');
        connectSignalingServer(); // still try to connect
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  //  STEP 2 — Connect to signaling server via Socket.io
  // ══════════════════════════════════════════════════════════
  function connectSignalingServer() {
    // Dynamically resolve the server URL:
    // - In production (EC2): same origin (e.g. http://your-ec2-ip:3000)
    // - In local dev: localhost:3000
    const serverUrl = window.SIGNALING_SERVER || location.origin;

    state.socket = io(serverUrl, {
      auth: { token: API.getToken() },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    state.socket.on('connect', () => {
      console.log('[socket] connected:', state.socket.id);
      // Join the call room
      state.socket.emit('join-room', {
        roomId,
        userId:   currentUser.id,
        userName: currentUser.name,
      });
    });

    state.socket.on('connect_error', (err) => {
      console.warn('[socket] connection error:', err.message);
      setRemoteStatus('Server unreachable…');
      showReconnectOverlay(true);
    });

    state.socket.on('reconnect', () => {
      showReconnectOverlay(false);
      state.socket.emit('join-room', { roomId, userId: currentUser.id, userName: currentUser.name });
    });

    // ── Room events ────────────────────────────────────────
    // Server tells us who is already in the room
    state.socket.on('room-peers', ({ peers }) => {
      console.log('[room] existing peers:', peers);
      if (peers.length > 0) {
        // Someone is already here — we are the joiner, create offer
        const peer = peers[0];
        state.remoteSocketId = peer.socketId;
        state.isInitiator    = true;
        createPeerConnection();
        startCallTimer();
        if (state.signDetectOn && state.localCam) startHandsDetection();
      } else {
        // We are first — wait for peer to join
        setRemoteStatus('Waiting for ' + contact.name + ' to join…');
        startCallTimer();
        if (state.signDetectOn && state.localCam) startHandsDetection();
      }
    });

    // A new peer joined our room
    state.socket.on('peer-joined', ({ socketId, userId, userName }) => {
      console.log('[room] peer joined:', userName, socketId);
      state.remoteSocketId = socketId;
      setRemoteStatus(userName + ' joined…');
      if (state.isInitiator || !state.peerConn) {
        // We should be the one who already had an offer ready
        createPeerConnection();
      }
    });

    // Peer left
    state.socket.on('peer-left', ({ socketId, userName }) => {
      console.log('[room] peer left:', userName);
      if (socketId === state.remoteSocketId) {
        setRemoteStatus(contact.name + ' left the call');
        addCaptionEntry('system', contact.name + ' left the call');
        UI.Toast.warning(contact.name + ' disconnected');
        handlePeerDisconnect();
      }
    });

    // ── WebRTC signaling ───────────────────────────────────
    state.socket.on('webrtc-offer', async ({ sdp, fromSocketId, fromUserName }) => {
      console.log('[webrtc] received offer from:', fromUserName);
      state.remoteSocketId = fromSocketId;
      if (!state.peerConn) createPeerConnection();
      try {
        await state.peerConn.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await state.peerConn.createAnswer();
        await state.peerConn.setLocalDescription(answer);
        state.socket.emit('webrtc-answer', {
          targetSocketId: fromSocketId,
          sdp: state.peerConn.localDescription,
        });
      } catch (e) {
        console.error('[webrtc] offer handling error:', e);
      }
    });

    state.socket.on('webrtc-answer', async ({ sdp, fromSocketId }) => {
      console.log('[webrtc] received answer');
      try {
        if (state.peerConn && state.peerConn.signalingState !== 'stable') {
          await state.peerConn.setRemoteDescription(new RTCSessionDescription(sdp));
        }
      } catch (e) {
        console.error('[webrtc] answer handling error:', e);
      }
    });

    state.socket.on('webrtc-ice', async ({ candidate, fromSocketId }) => {
      try {
        if (state.peerConn && candidate) {
          await state.peerConn.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch (e) {
        console.warn('[webrtc] ICE error:', e.message);
      }
    });

    // ── Feature events from remote peer ───────────────────
    state.socket.on('sign_caption', ({ gesture, confidence, userName }) => {
      if (!state.captionsOn) return;

      // 1. Large animated subtitle on Person B's screen
      showRemoteSignCaption(gesture, confidence, userName);

      // 2. Bottom caption bar — very visible text
      captionFinal.textContent = `🤟 ${gesture}`;
      captionBar.classList.remove('hidden');
      clearTimeout(state._signCaptionTimer);
      state._signCaptionTimer = setTimeout(() => {
        if (captionFinal.textContent === `🤟 ${gesture}`) {
          captionFinal.textContent = '';
          if (!captionInterim.textContent) captionBar.classList.add('hidden');
        }
      }, 4500);

      // 3. Caption history log
      addCaptionEntry('sign', gesture, userName);

      // 4. Speak the sign aloud on Person B's device
      SpeechEngine.speak(gesture, { lang: 'en-US', rate: 0.85, pitch: 1.05, volume: 1.0 });
    });

    state.socket.on('speech_caption', ({ text, isFinal, userName }) => {
      if (!state.captionsOn) return;
      if (isFinal) {
        captionFinal.textContent   = text;
        captionInterim.textContent = '';
        addCaptionEntry('speech', text, userName);
        setTimeout(() => {
          if (captionFinal.textContent === text) captionFinal.textContent = '';
        }, 5000);
      } else {
        captionInterim.textContent = text;
      }
      captionBar.classList.remove('hidden');
    });

    state.socket.on('chat_message', ({ text, userName, timestamp }) => {
      addCaptionEntry('system', `${userName}: ${text}`);
      UI.Toast.info(`💬 ${userName}: ${text}`);
    });

    state.socket.on('call_control', ({ type, value, userName }) => {
      if (type === 'mic_mute') {
        UI.Toast.info(value ? `${userName} unmuted` : `${userName} muted`);
      } else if (type === 'cam_off') {
        UI.Toast.info(value ? `${userName} camera on` : `${userName} camera off`);
      }
    });

    state.socket.on('screen_share', ({ active, userName }) => {
      UI.Toast.info(active ? `${userName} started screen sharing` : `${userName} stopped screen sharing`);
    });

    state.socket.on('call_ended', () => {
      UI.Toast.warning(contact.name + ' ended the call');
      endCall(false);
    });
  }

  // ══════════════════════════════════════════════════════════
  //  STEP 3 — Create RTCPeerConnection
  // ══════════════════════════════════════════════════════════
  function createPeerConnection() {
    if (state.peerConn) {
      state.peerConn.close();
      state.peerConn = null;
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    state.peerConn = pc;

    // Add local tracks to peer connection
    if (state.localStream) {
      state.localStream.getTracks().forEach(track => {
        pc.addTrack(track, state.localStream);
      });
    }

    // ICE candidate generated → send to remote via signaling
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && state.remoteSocketId) {
        state.socket.emit('webrtc-ice', {
          targetSocketId: state.remoteSocketId,
          candidate,
        });
      }
    };

    pc.onicegatheringstatechange = () => {
      console.log('[webrtc] ICE gathering:', pc.iceGatheringState);
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[webrtc] ICE connection:', pc.iceConnectionState);
      switch (pc.iceConnectionState) {
        case 'connected':
        case 'completed':
          state.connected = true;
          showReconnectOverlay(false);
          setRemoteStatus('Connected · HD');
          break;
        case 'disconnected':
          setRemoteStatus('Reconnecting…');
          showReconnectOverlay(true);
          break;
        case 'failed':
          setRemoteStatus('Connection failed');
          if (state.reconnectAttempts < state.maxReconnect) {
            state.reconnectAttempts++;
            setTimeout(() => restartIce(), 2000);
          }
          break;
        case 'closed':
          state.connected = false;
          break;
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[webrtc] connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        state.connected = true;
        showReconnectOverlay(false);
      }
    };

    // Remote stream arrived → show in remote video element
    pc.ontrack = (event) => {
      console.log('[webrtc] remote track received:', event.track.kind);
      if (!state.remoteStream) {
        state.remoteStream = new MediaStream();
        remoteVideo.srcObject = state.remoteStream;
        remotePlaceholder.style.opacity = '0';
        setTimeout(() => remotePlaceholder.style.display = 'none', 500);
        addCaptionEntry('system', contact.name + ' connected');
        UI.Toast.success(contact.name + ' joined the call!');
      }
      state.remoteStream.addTrack(event.track);

      event.track.onunmute = () => {
        if (!remoteVideo.srcObject) remoteVideo.srcObject = state.remoteStream;
      };
    };

    pc.onnegotiationneeded = async () => {
      // Only the initiator creates offers
      if (!state.isInitiator) return;
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: callMode !== 'voice',
        });
        await pc.setLocalDescription(offer);
        if (state.remoteSocketId) {
          state.socket.emit('webrtc-offer', {
            targetSocketId: state.remoteSocketId,
            sdp: pc.localDescription,
          });
        }
      } catch (e) {
        console.error('[webrtc] offer creation error:', e);
      }
    };

    return pc;
  }

  // ICE restart on failure
  async function restartIce() {
    if (!state.peerConn || !state.isInitiator) return;
    try {
      const offer = await state.peerConn.createOffer({ iceRestart: true });
      await state.peerConn.setLocalDescription(offer);
      state.socket.emit('webrtc-offer', {
        targetSocketId: state.remoteSocketId,
        sdp: state.peerConn.localDescription,
      });
    } catch (e) {
      console.error('[webrtc] ICE restart failed:', e);
    }
  }

  function handlePeerDisconnect() {
    if (state.remoteStream) {
      state.remoteStream.getTracks().forEach(t => t.stop());
      state.remoteStream = null;
    }
    remoteVideo.srcObject = null;
    remotePlaceholder.style.display = 'flex';
    remotePlaceholder.style.opacity = '1';
    state.connected = false;
  }

  // ══════════════════════════════════════════════════════════
  //  STEP 4 — MediaPipe Sign Detection on LOCAL video
  // ══════════════════════════════════════════════════════════
  function startHandsDetection() {
    if (typeof Hands === 'undefined' && typeof Holistic === 'undefined') {
      UI.Toast.warning('MediaPipe not loaded — sign detection disabled.');
      return;
    }

    // Use Holistic if available (better for full-body signs), else Hands
    const useHolistic = typeof Holistic !== 'undefined';

    if (useHolistic) {
      state.handsInstance = new Holistic({
        locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${f}`
      });
      state.handsInstance.setOptions({
        modelComplexity:        1,
        smoothLandmarks:        true,
        enableSegmentation:     false,
        refineFaceLandmarks:    false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence:  0.5,
      });
      state.handsInstance.onResults(onLocalHandResults);
    } else {
      state.handsInstance = new Hands({
        locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
      });
      state.handsInstance.setOptions({
        maxNumHands: 1, modelComplexity: 0,
        minDetectionConfidence: 0.6, minTrackingConfidence: 0.5,
      });
      state.handsInstance.onResults(onLocalHandResults);
    }

    let rafActive = true;
    state._signRafActive = () => rafActive;
    state._signRafStop   = () => { rafActive = false; };

    const detectLoop = async () => {
      if (!rafActive) return;
      if (state.signDetectOn && state.localCam &&
          localVideo.srcObject && localVideo.readyState >= 2 && !localVideo.paused) {
        try { await state.handsInstance.send({ image: localVideo }); } catch {}
      }
      setTimeout(() => { if (rafActive) requestAnimationFrame(detectLoop); }, 66);
    };
    requestAnimationFrame(detectLoop);
  }

  function onLocalHandResults(results) {
    const ctx = localCanvas.getContext('2d');
    GestureEngine.clearCanvas(ctx, localCanvas.width, localCanvas.height);

    // Build landmark object for GestureEngine
    // Holistic gives results.poseLandmarks, results.leftHandLandmarks, results.rightHandLandmarks
    // Hands gives results.multiHandLandmarks[0]
    const isHolistic = results.poseLandmarks !== undefined;
    let landmarks;

    if (isHolistic) {
      landmarks = {
        pose:      results.poseLandmarks || null,
        leftHand:  results.leftHandLandmarks  || null,
        rightHand: results.rightHandLandmarks || null,
      };
      // Draw hand skeleton on PiP
      const drawLm = results.rightHandLandmarks || results.leftHandLandmarks;
      if (drawLm) GestureEngine.drawHandOnCanvas(ctx, drawLm, localCanvas.width, localCanvas.height, true);
    } else {
      if (!results.multiHandLandmarks?.length) {
        localSignLabel.classList.remove('visible');
        callConfidence.classList.remove('visible');
        return;
      }
      landmarks = results.multiHandLandmarks[0];
      GestureEngine.drawHandOnCanvas(ctx, landmarks, localCanvas.width, localCanvas.height, true);
    }

    const result = GestureEngine.processFrame(landmarks);
    if (!result) return;

    const pct = Math.round(result.confidence * 100);
    callConfFill.style.width = pct + '%';
    callConfPct.textContent  = pct + '%';
    callConfidence.classList.toggle('visible', result.confidence > 0.3);

    if (result.name && result.name !== '...') {
      localSignLabel.textContent = `✋ ${result.name}`;
      localSignLabel.classList.add('visible');
    } else {
      localSignLabel.classList.remove('visible');
    }

    if (result.emit && result.name && result.name !== '...') {
      addCaptionEntry('sign', result.name, 'You');
      if (state.socket && state.socket.connected) {
        state.socket.emit('sign_caption', {
          roomId, gesture: result.name, confidence: pct, userName: currentUser.name,
        });
      }
    }
  }

  // Show a sign caption bubble on the REMOTE video side
  // (this is what the remote user's signs look like to you)
  function showRemoteSignCaption(text, confidence, userName) {
    const bubble = document.createElement('div');
    bubble.className = 'sign-caption-bubble';
    bubble.innerHTML = `<span aria-hidden="true">✋</span> ${escHtml(text)}
      <small style="opacity:0.7;font-size:0.75em;margin-left:6px">${confidence}%</small>`;
    signCaptionArea.appendChild(bubble);

    setTimeout(() => {
      bubble.classList.add('fade-out');
      bubble.addEventListener('animationend', () => bubble.remove(), { once: true });
    }, 3000);
  }

  // ══════════════════════════════════════════════════════════
  //  STEP 5 — Speech Recognition (your speech → remote captions)
  // ══════════════════════════════════════════════════════════
  function startSpeech() {
    if (!SpeechEngine.isSTTSupported()) {
      UI.Toast.error('Speech recognition requires Chrome or Edge browser.');
      return;
    }
    SpeechEngine.startSTT({
      lang:        'en-US',
      continuous:  true,
      autoRestart: true,
      onInterim: (text) => {
        if (!state.captionsOn) return;
        captionInterim.textContent = text;
        captionFinal.textContent   = '';
        captionBar.classList.remove('hidden');
        // Send interim to remote
        emitSpeechCaption(text, false);
      },
      onFinal: (text) => {
        if (!state.captionsOn) return;
        captionInterim.textContent = '';
        captionFinal.textContent   = text;
        captionBar.classList.remove('hidden');
        addCaptionEntry('speech', text, 'You');
        emitSpeechCaption(text, true);
        // Save to chat
        API.Messages.send(contactId, text, 'text').catch(()=>{});
        setTimeout(() => {
          if (captionFinal.textContent === text) captionFinal.textContent = '';
          if (!captionInterim.textContent) captionBar.classList.add('hidden');
        }, 5000);
      },
      onError:  (msg) => UI.Toast.error(msg),
      onStatus: (s) => {
        $('ctrlSpeech').classList.toggle('active', s === 'listening');
        $('ctrlSpeech').setAttribute('aria-pressed', s === 'listening');
        $('ctrlSpeech').querySelector('.ctrl-label').textContent = s === 'listening' ? 'Listening' : 'Speech';
      },
    });
    state.speechOn = true;
  }

  function stopSpeech() {
    SpeechEngine.stopSTT();
    state.speechOn = false;
    captionInterim.textContent = '';
    captionFinal.textContent   = '';
    captionBar.classList.add('hidden');
    $('ctrlSpeech').classList.remove('active');
    $('ctrlSpeech').setAttribute('aria-pressed', 'false');
    $('ctrlSpeech').querySelector('.ctrl-label').textContent = 'Speech';
  }

  function emitSpeechCaption(text, isFinal) {
    if (state.socket?.connected) {
      state.socket.emit('speech_caption', {
        roomId, text, isFinal,
        userName: currentUser.name,
      });
    }
  }

  // ══════════════════════════════════════════════════════════
  //  Controls
  // ══════════════════════════════════════════════════════════
  $('ctrlMic').addEventListener('click', () => {
    state.localMic = !state.localMic;
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach(t => t.enabled = state.localMic);
    }
    $('ctrlMic').classList.toggle('muted', !state.localMic);
    $('ctrlMic').textContent = state.localMic ? '🎙️' : '🔇';
    $('ctrlMic').setAttribute('aria-pressed', state.localMic);
    $('ctrlMic').querySelector('.ctrl-label').textContent = state.localMic ? 'Mic' : 'Unmuted';
    // Notify remote
    state.socket?.emit('call_control', { roomId, type: 'mic_mute', value: state.localMic, userName: currentUser.name });
    UI.Toast.info(state.localMic ? 'Microphone on' : 'Microphone muted');
  });

  $('ctrlCam').addEventListener('click', () => {
    state.localCam = !state.localCam;
    if (state.localStream) {
      state.localStream.getVideoTracks().forEach(t => t.enabled = state.localCam);
    }
    $('ctrlCam').classList.toggle('disabled-cam', !state.localCam);
    $('ctrlCam').textContent = state.localCam ? '📷' : '🚫';
    $('ctrlCam').setAttribute('aria-pressed', state.localCam);
    $('ctrlCam').querySelector('.ctrl-label').textContent = state.localCam ? 'Camera' : 'Cam Off';
    state.socket?.emit('call_control', { roomId, type: 'cam_off', value: state.localCam, userName: currentUser.name });
    UI.Toast.info(state.localCam ? 'Camera on' : 'Camera off');
  });

  $('ctrlSign').addEventListener('click', () => {
    state.signDetectOn = !state.signDetectOn;
    $('ctrlSign').classList.toggle('active', state.signDetectOn);
    $('ctrlSign').setAttribute('aria-pressed', state.signDetectOn);
    if (!state.signDetectOn) {
      const ctx = localCanvas.getContext('2d');
      GestureEngine.clearCanvas(ctx, localCanvas.width, localCanvas.height);
      localSignLabel.classList.remove('visible');
      UI.Toast.info('Sign detection off');
    } else {
      if (!state.handsInstance && state.localCam) startHandsDetection();
      UI.Toast.success('Sign detection on 🤟');
    }
  });

  $('ctrlCC').addEventListener('click', () => {
    state.captionsOn = !state.captionsOn;
    $('ctrlCC').classList.toggle('active', state.captionsOn);
    $('ctrlCC').setAttribute('aria-pressed', state.captionsOn);
    captionBar.classList.toggle('hidden', !state.captionsOn);
    UI.Toast.info(state.captionsOn ? 'Captions on' : 'Captions off');
  });

  $('ctrlSpeech').addEventListener('click', () => {
    if (state.speechOn) { stopSpeech(); UI.Toast.info('Speech captions off'); }
    else { startSpeech(); UI.Toast.success('Speech → Captions active 🎤'); }
  });

  $('ctrlHistory').addEventListener('click', () => {
    const open = captionHistory.classList.toggle('open');
    $('ctrlHistory').classList.toggle('active', open);
    $('ctrlHistory').setAttribute('aria-pressed', open);
  });

  $('captionHistoryClose').addEventListener('click', () => {
    captionHistory.classList.remove('open');
    $('ctrlHistory').classList.remove('active');
    $('ctrlHistory').setAttribute('aria-pressed', 'false');
  });

  $('ctrlScreen').addEventListener('click', async () => {
    if (!state.screenSharing) {
      try {
        state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        // Replace video track in peer connection
        const screenTrack = state.screenStream.getVideoTracks()[0];
        if (state.peerConn) {
          const sender = state.peerConn.getSenders().find(s => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        }
        state.screenSharing = true;
        $('ctrlScreen').classList.add('active');
        $('screenshareBadge').classList.add('visible');
        screenTrack.onended = () => stopScreenShare();
        state.socket?.emit('screen_share', { roomId, active: true, userName: currentUser.name });
        UI.Toast.success('Screen sharing started 🖥️');
      } catch (e) {
        if (e.name !== 'NotAllowedError') UI.Toast.error('Screen share: ' + e.message);
      }
    } else {
      stopScreenShare();
    }
  });

  function stopScreenShare() {
    if (state.screenStream) { state.screenStream.getTracks().forEach(t => t.stop()); state.screenStream = null; }
    // Restore camera track
    if (state.peerConn && state.localStream) {
      const camTrack = state.localStream.getVideoTracks()[0];
      const sender   = state.peerConn.getSenders().find(s => s.track?.kind === 'video');
      if (sender && camTrack) sender.replaceTrack(camTrack);
    }
    state.screenSharing = false;
    $('ctrlScreen').classList.remove('active');
    $('screenshareBadge').classList.remove('visible');
    state.socket?.emit('screen_share', { roomId, active: false, userName: currentUser.name });
    UI.Toast.info('Screen sharing stopped');
  }

  $('ctrlEnd').addEventListener('click', () => endCall(true));
  $('btnBackToChat').addEventListener('click', () => endCall(true));

  function endCall(sendEvent = true) {
    if (sendEvent && state.socket?.connected) {
      state.socket.emit('call_end', { roomId });
    }
    // Cleanup
    clearInterval(state.callTimer);
    stopSpeech();
    if (state.handsInstance) { try { state.handsInstance.close(); } catch {} }
    if (state._signRafStop)  { state._signRafStop(); }
    if (state.peerConn)      { state.peerConn.close(); state.peerConn = null; }
    if (state.localStream)   { state.localStream.getTracks().forEach(t => t.stop()); }
    if (state.screenStream)  { state.screenStream.getTracks().forEach(t => t.stop()); }
    if (state.socket)        { state.socket.disconnect(); }
    window.location.href = 'app.html';
  }

  // ══════════════════════════════════════════════════════════
  //  UI Helpers
  // ══════════════════════════════════════════════════════════
  function setRemoteStatus(text) {
    if (remoteStatusEl) remoteStatusEl.textContent = text;
  }

  function showReconnectOverlay(show) {
    const overlay = $('reconnectOverlay');
    if (overlay) overlay.classList.toggle('visible', show);
  }

  function addCaptionEntry(type, text, speaker = '') {
    const entry = document.createElement('div');
    entry.className = 'caption-entry';
    const src = type === 'sign'
      ? `<span class="caption-entry-source sign">✋ ${escHtml(speaker)} (Sign)</span>`
      : type === 'speech'
      ? `<span class="caption-entry-source speech">🎤 ${escHtml(speaker)} (Speech)</span>`
      : `<span class="caption-entry-source" style="color:var(--color-text-3)">ℹ ${escHtml(speaker||'System')}</span>`;
    entry.innerHTML = `
      <div class="caption-entry-meta">
        ${src}
        <span class="caption-entry-time">${UI.Format.time(Date.now())}</span>
      </div>
      <div class="caption-entry-text">${escHtml(text)}</div>`;
    captionList.appendChild(entry);
    captionList.scrollTop = captionList.scrollHeight;
    while (captionList.children.length > 80) captionList.removeChild(captionList.firstChild);
  }

  function startCallTimer() {
    clearInterval(state.callTimer);
    state.callTimer = setInterval(() => {
      state.callSeconds++;
      callDuration.textContent = UI.Format.duration(state.callSeconds);
    }, 1000);
  }

  // Auto-hide controls
  function showControls() {
    controlsBar.classList.remove('fading');
    callTopbar.classList.remove('fading');
    clearTimeout(state.controlsHideTimer);
    state.controlsHideTimer = setTimeout(() => {
      controlsBar.classList.add('fading');
      callTopbar.classList.add('fading');
    }, 4000);
  }
  document.addEventListener('mousemove',  UI.throttle(showControls, 300));
  document.addEventListener('touchstart', showControls, { passive: true });
  showControls();

  // Draggable PiP
  (function (el) {
    let drag = false, ox = 0, oy = 0;
    const start = (cx, cy) => { drag = true; const r = el.getBoundingClientRect(); ox = cx-r.left; oy = cy-r.top; el.classList.add('dragging'); };
    const move  = (cx, cy) => { if (!drag) return;
      el.style.right = 'auto'; el.style.top = 'auto';
      el.style.left  = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  cx - ox)) + 'px';
      el.style.top   = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, cy - oy)) + 'px';
    };
    const end = () => { drag = false; el.classList.remove('dragging'); };
    el.addEventListener('mousedown',  e => { if(e.target.id!=='pipResize') start(e.clientX,e.clientY); e.preventDefault(); });
    document.addEventListener('mousemove', e => move(e.clientX,e.clientY));
    document.addEventListener('mouseup',   end);
    el.addEventListener('touchstart', e => { const t=e.touches[0]; start(t.clientX,t.clientY); }, { passive:true });
    document.addEventListener('touchmove', e => { const t=e.touches[0]; move(t.clientX,t.clientY); }, { passive:true });
    document.addEventListener('touchend',  end);
  })(localVideoWrap);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (k==='m') $('ctrlMic').click();
    else if (k==='v') $('ctrlCam').click();
    else if (k==='c') $('ctrlCC').click();
    else if (k==='s') $('ctrlSign').click();
    else if (k==='escape') endCall(true);
  });

  function escHtml(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Quality indicator update
  setInterval(() => {
    if (!state.peerConn) return;
    state.peerConn.getStats().then(stats => {
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const rtt = report.currentRoundTripTime;
          const bars = document.querySelectorAll('.quality-bar');
          bars.forEach((b, i) => b.classList.toggle('active',
            rtt === undefined ? i < 3 : rtt < 0.05 ? true : rtt < 0.15 ? i < 3 : rtt < 0.3 ? i < 2 : i < 1
          ));
        }
      });
    }).catch(() => {});
  }, 3000);

  // Cleanup on page close
  window.addEventListener('beforeunload', () => {
    if (state.localStream)  state.localStream.getTracks().forEach(t => t.stop());
    if (state.screenStream) state.screenStream.getTracks().forEach(t => t.stop());
    if (state.socket?.connected) state.socket.emit('call_end', { roomId });
  });

  // ── Set active defaults & boot ────────────────────────────
  $('ctrlSign').classList.add('active');
  $('ctrlCC').classList.add('active');
  $('ctrlSign').setAttribute('aria-pressed', 'true');
  $('ctrlCC').setAttribute('aria-pressed', 'true');

  // Boot sequence
  initLocalStream();

})();

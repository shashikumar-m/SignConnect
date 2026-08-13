/**
 * SignCall — Chat App (100% server-backed, zero localStorage data)
 * app.js
 */
(async function () {
  'use strict';

  // ── Auth guard — fetch real user from server ─────────────────
  if (!API.isLoggedIn()) { window.location.href = 'index.html'; return; }

  let currentUser;
  try {
    currentUser = await API.Auth.me();   // fresh from MongoDB
  } catch (err) {
    UI.Toast.error('Session error: ' + err.message);
    API.Auth.logout();
    return;
  }

  // ── Socket.io (real-time notifications) ─────────────────────
  const socket = io(window.location.origin, {
    auth: { token: API.getToken() },
    transports: ['websocket','polling'],
  });

  socket.on('connect', () => console.log('[socket] connected'));
  socket.on('connect_error', (e) => console.warn('[socket] error:', e.message));

  // ── Incoming call notification ────────────────────────────────
  socket.on('call:incoming', ({ roomId, callMode, caller }) => {
    showIncomingCall(roomId, callMode, caller);
  });

  socket.on('call:rejected', ({ roomId }) => {
    dismissIncomingCallUI();
    UI.Toast.warning('Call was rejected.');
  });

  // Real-time new message notification
  socket.on('new_message', (msg) => {
    const cid = msg.from?._id || msg.from;
    if (state.activeContactId === cid) {
      appendMsgEl(msg);
      UI.scrollToBottom(messagesArea);
    } else {
      UI.Toast.info(`💬 ${msg.from?.name || 'Someone'}: ${API.Format.msgPreview(msg)}`);
    }
    refreshContactList();
  });

  // Typing indicator
  socket.on('typing', ({ fromUserId, fromName, isTyping }) => {
    if (fromUserId === state.activeContactId) {
      const typingEl = document.getElementById('typingIndicator');
      if (typingEl) typingEl.textContent = isTyping ? `${fromName} is typing…` : '';
    }
  });

  // Online presence updates
  socket.on('presence', ({ userId, isOnline, lastSeen }) => {
    // Update contact item in list
    const item = contactsList.querySelector(`[data-id="${userId}"]`);
    if (item) {
      const dot = item.querySelector('.contact-status');
      if (dot) {
        dot.className = `contact-status status-dot ${isOnline ? 'status-online' : 'status-offline'}`;
      }
    }
    // Update chat header if this is the active contact
    if (userId === state.activeContactId) {
      const sub = document.getElementById('chatHeaderSub');
      if (sub) sub.textContent = isOnline ? '● Online' : `Last seen ${API.Format.relativeTime(lastSeen)}`;
    }
  });

  // ── State ────────────────────────────────────────────────────
  const state = {
    activeContactId: null,
    contacts: [],
    signPanelOpen: false,
    signStream: null,
    handsInstance: null,
    cameraUtil: null,
    signWords: [],
    signRunning: false,
    typingTimer: null,
  };

  // ── DOM refs ─────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const contactsList  = $('contactsList');
  const messagesArea  = $('messagesArea');
  const chatHeader    = $('chatHeader');
  const inputBar      = $('inputBar');
  const welcomeScreen = $('welcomeScreen');
  const msgInput      = $('msgInput');
  const signPanel     = $('signPanel');
  const signWordQueue = $('signWordQueue');
  const signGestureLabel = $('signGestureLabel');
  const signConfFill  = $('signConfFill');
  const signConfPct   = $('signConfPct');
  const signVideo     = $('signVideo');
  const signCanvas    = $('signCanvas');
  const btnSend       = $('btnSend');
  const btnSendSign   = $('btnSendSign');
  const emojiPicker   = $('emojiPicker');

  // ── Init user avatar in rail ─────────────────────────────────
  const navAvatar = $('navAvatar');
  if (navAvatar) {
    navAvatar.textContent = API.Format.initials(currentUser.name);
    navAvatar.style.background = currentUser.avatarColor || 'var(--color-primary)';
  }

  // ── Load contacts on boot ─────────────────────────────────────
  loadContacts();

  async function loadContacts() {
    contactsList.innerHTML = UI.Skeleton.contacts(4);
    try {
      state.contacts = await API.Contacts.getAll();
      renderContactList();
    } catch (err) {
      UI.Toast.error('Could not load contacts: ' + err.message);
      contactsList.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-desc">Could not load contacts</p></div>`;
    }
  }

  function renderContactList(filter = '') {
    const q = filter.toLowerCase();
    const filtered = state.contacts.filter(c =>
      !q || c.name.toLowerCase().includes(q) || (c.username && c.username.toLowerCase().includes(q))
    );

    if (!filtered.length) {
      contactsList.innerHTML = `<div class="empty-state">
        <div class="empty-icon">${filter ? '🔍' : '💬'}</div>
        <div class="empty-title">${filter ? 'No results' : 'No contacts yet'}</div>
        <p class="empty-desc">${filter ? 'Try a different search.' : 'Click + to add a contact.'}</p>
      </div>`;
      return;
    }

    contactsList.innerHTML = filtered.map(c => {
      const isActive = state.activeContactId === (c._id || c.id);
      const statusCls = c.isOnline ? 'status-online' : 'status-offline';
      return `<div class="contact-item${isActive?' active':''}" data-id="${c._id||c.id}" role="listitem" tabindex="0">
        <div class="contact-avatar-wrap">
          <div class="avatar avatar-md" style="background:${c.avatarColor||'var(--color-primary)'}">
            ${API.Format.initials(c.name)}
          </div>
          <span class="contact-status status-dot ${statusCls}" aria-label="${c.isOnline?'Online':'Offline'}"></span>
        </div>
        <div class="contact-info">
          <div class="contact-name">${escHtml(c.name)}</div>
          <div class="contact-last-msg text-faint">${c.isOnline ? '● Online' : API.Format.relativeTime(c.lastSeen)}</div>
        </div>
      </div>`;
    }).join('');

    contactsList.querySelectorAll('.contact-item').forEach(item => {
      const open = () => {
        const cid = item.dataset.id;
        const contact = state.contacts.find(c => (c._id||c.id) === cid);
        if (contact) openChatWith(contact);
      };
      item.addEventListener('click', open);
      item.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') open(); });
    });
  }

  async function refreshContactList() {
    try {
      state.contacts = await API.Contacts.getAll();
      renderContactList($('contactSearch').value || '');
    } catch {}
  }

  // ── Open chat ─────────────────────────────────────────────────
  async function openChatWith(contact) {
    const cid = contact._id || contact.id;
    state.activeContactId = cid;

    welcomeScreen.classList.add('hidden');
    chatHeader.classList.remove('hidden');
    messagesArea.classList.remove('hidden');
    inputBar.classList.remove('hidden');

    $('chatHeaderAvatar').textContent = API.Format.initials(contact.name);
    $('chatHeaderAvatar').style.background = contact.avatarColor || 'var(--color-primary)';
    $('chatHeaderName').textContent = contact.name;
    $('chatHeaderSub').textContent  = contact.isOnline ? '● Online' : `Last seen ${API.Format.relativeTime(contact.lastSeen)}`;

    $('btnVideoCall').onclick = () => startCall(cid, contact, 'video');
    $('btnVoiceCall').onclick = () => startCall(cid, contact, 'voice');

    renderContactList($('contactSearch').value || '');

    // Load messages from server
    messagesArea.innerHTML = `<div style="text-align:center;padding:20px;color:var(--color-text-3)">Loading…</div>`;
    try {
      const msgs = await API.Messages.getConversation(cid);
      renderMessages(msgs);
    } catch (err) {
      messagesArea.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p>${escHtml(err.message)}</p></div>`;
    }
    msgInput.focus();
  }

  function renderMessages(msgs) {
    messagesArea.innerHTML = '';
    if (!msgs.length) {
      messagesArea.innerHTML = `<div class="empty-state"><div class="empty-icon">💬</div>
        <div class="empty-title">Start the conversation</div>
        <p class="empty-desc">Say hello or sign a greeting!</p></div>`;
      return;
    }
    let lastDate = null;
    msgs.forEach(msg => {
      const d = new Date(msg.timestamp).toDateString();
      if (d !== lastDate) {
        lastDate = d;
        const div = document.createElement('div');
        div.className = 'date-divider';
        div.innerHTML = `<span class="date-label">${d === new Date().toDateString() ? 'Today' : d}</span>`;
        messagesArea.appendChild(div);
      }
      appendMsgEl(msg);
    });
    UI.scrollToBottom(messagesArea, false);
    // Typing indicator placeholder
    const typing = document.createElement('div');
    typing.id = 'typingIndicator';
    typing.style.cssText = 'font-size:0.78rem;color:var(--color-text-3);padding:4px 20px;min-height:20px';
    messagesArea.appendChild(typing);
  }

  function appendMsgEl(msg) {
    const uid = currentUser._id || currentUser.id;
    const isMe = (msg.from?._id || msg.from) === uid || (msg.from?._id || msg.from)?.toString() === uid?.toString();
    const contact = state.contacts.find(c => (c._id||c.id) === state.activeContactId);

    const row = document.createElement('div');
    row.className = `msg-row ${isMe ? 'sent' : 'recv'}`;

    let bubble = '';
    if (msg.type === 'sign') {
      bubble = `<div class="msg-bubble msg-sign${isMe?' sent':''}">
        <div class="sign-label">✋ ${escHtml(msg.signLabel||'ASL Sign')}</div>
        ${escHtml(msg.content)}
      </div>`;
    } else {
      bubble = `<div class="msg-bubble">${escHtml(msg.content)}</div>`;
    }

    const avatarHtml = !isMe
      ? `<div class="avatar avatar-sm" style="background:${contact?.avatarColor||'var(--color-primary)'}">${API.Format.initials(contact?.name||'?')}</div>`
      : '';

    row.innerHTML = `${avatarHtml}<div>${bubble}
      <span class="msg-time">${API.Format.time(msg.timestamp)}${isMe?' ✓✓':''}</span>
    </div>`;
    messagesArea.appendChild(row);
  }

  // ── Send message ──────────────────────────────────────────────
  async function sendTextMessage() {
    const text = msgInput.value.trim();
    if (!text || !state.activeContactId) return;
    btnSend.disabled = true;
    msgInput.value = '';
    msgInput.style.height = 'auto';

    try {
      const msg = await API.Messages.send(state.activeContactId, text);
      appendMsgEl(msg);
      UI.scrollToBottom(messagesArea);
    } catch (err) {
      UI.Toast.error('Send failed: ' + err.message);
      msgInput.value = text; // restore
    }
    btnSend.disabled = false;
  }

  msgInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 140) + 'px';
    btnSend.disabled = !this.value.trim();
    // Typing indicator
    if (state.activeContactId) {
      socket.emit('typing', { toUserId: state.activeContactId, isTyping: true });
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(() => {
        socket.emit('typing', { toUserId: state.activeContactId, isTyping: false });
      }, 1500);
    }
  });
  msgInput.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); } });
  btnSend.addEventListener('click', sendTextMessage);

  // ── Contact search ────────────────────────────────────────────
  $('contactSearch').addEventListener('input', UI.debounce(function(e) {
    renderContactList((e.target || this || {}).value || '');
  }, 200));

  // ── Navigation tabs ───────────────────────────────────────────
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected','false'); });
      tab.classList.add('active'); tab.setAttribute('aria-selected','true');
    });
  });
  $('railLogout').addEventListener('click', () => { if (confirm('Sign out?')) API.Auth.logout(); });

  // ── Add contact modal ─────────────────────────────────────────
  const addContactModal = $('addContactModal');
  $('btnAddContact').addEventListener('click', () => UI.Modal.open(addContactModal));
  $('welcomeAddBtn').addEventListener('click', () => UI.Modal.open(addContactModal));
  $('addContactClose').addEventListener('click', () => UI.Modal.close(addContactModal));

  $('addContactSearch').addEventListener('input', UI.debounce(async function(e) {
    const q = ((e && e.target) ? e.target.value : (this && this.value) || '').trim();
    const results = $('addContactResults');
    if (q.length < 2) { results.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p class="empty-desc">Type at least 2 characters</p></div>`; return; }
    results.innerHTML = `<div style="padding:12px;text-align:center;color:var(--color-text-3)">Searching…</div>`;
    try {
      const users = await API.Users.search(q);
      if (!users.length) { results.innerHTML = `<div class="empty-state"><div class="empty-icon">😕</div><p class="empty-desc">No users found</p></div>`; return; }
      const isContact = (id) => state.contacts.some(c => (c._id||c.id) === id);
      results.innerHTML = users.map(u => `
        <div class="search-result-item" data-uid="${u._id||u.id}">
          <div class="avatar avatar-md" style="background:${u.avatarColor||'var(--color-primary)'}">${API.Format.initials(u.name)}</div>
          <div style="flex:1">
            <div style="font-weight:600;font-size:0.9rem">${escHtml(u.name)}</div>
            <div style="font-size:0.78rem;color:var(--color-text-3)">@${escHtml(u.username)} · ${escHtml(u.userType)}</div>
          </div>
          ${isContact(u._id||u.id)
            ? '<span style="font-size:0.78rem;color:var(--color-accent)">✓ Added</span>'
            : `<button class="btn btn-primary btn-sm" data-add="${u._id||u.id}">Add</button>`}
        </div>`).join('');
      results.querySelectorAll('[data-add]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const uid = btn.dataset.add;
          btn.disabled = true; btn.textContent = 'Adding…';
          try {
            await API.Contacts.add(uid);
            btn.textContent = '✓ Added';
            UI.Toast.success('Contact added!');
            await loadContacts();
          } catch (err) {
            btn.disabled = false; btn.textContent = 'Add';
            UI.Toast.error(err.message);
          }
        });
      });
    } catch (err) { results.innerHTML = `<div class="empty-state"><p>${escHtml(err.message)}</p></div>`; }
  }, 350));

  // ── Profile modal ─────────────────────────────────────────────
  const profileModal = $('profileModal');
  $('railProfile').addEventListener('click', async () => {
    try {
      const u = await API.Auth.me();   // always fetch fresh from server
      $('profileName').value = u?.name || '';
      $('profileBio').value  = u?.bio  || '';
      $('profileAvatar').textContent = API.Format.initials(u?.name||'?');
      $('profileAvatar').style.background = u?.avatarColor || 'var(--color-primary)';
      UI.Modal.open(profileModal);
    } catch (err) { UI.Toast.error('Could not load profile: ' + err.message); }
  });
  $('profileClose').addEventListener('click', () => UI.Modal.close(profileModal));
  $('btnSaveProfile').addEventListener('click', async () => {
    try {
      const user = await API.Auth.updateProfile({ name: $('profileName').value.trim(), bio: $('profileBio').value.trim() });
      if ($('navAvatar')) $('navAvatar').textContent = API.Format.initials(user.name);
      UI.Toast.success('Profile updated ✓');
      UI.Modal.close(profileModal);
    } catch (err) { UI.Toast.error(err.message); }
  });

  // ── Sign language panel ───────────────────────────────────────
  $('btnSignToggle').addEventListener('click', () => {
    state.signPanelOpen = !state.signPanelOpen;
    signPanel.classList.toggle('open', state.signPanelOpen);
    $('btnSignToggle').setAttribute('aria-pressed', state.signPanelOpen);
    if (!state.signPanelOpen) stopSignCapture();
  });
  $('btnCloseSign').addEventListener('click', () => { state.signPanelOpen = false; signPanel.classList.remove('open'); stopSignCapture(); });
  $('btnStartSign').addEventListener('click', startSignCapture);
  $('btnStopSign') .addEventListener('click', stopSignCapture);
  $('btnClearSign').addEventListener('click', clearSignWords);

  $('btnSendSign').addEventListener('click', async () => {
    if (!state.signWords.length || !state.activeContactId) return;
    const content   = state.signWords.join(' ');
    const signLabel = 'ASL: ' + state.signWords.join(', ');
    try {
      const msg = await API.Messages.send(state.activeContactId, content, 'sign', signLabel);
      appendMsgEl(msg);
      UI.scrollToBottom(messagesArea);
      clearSignWords();
    } catch (err) { UI.Toast.error(err.message); }
  });

  async function startSignCapture() {
    $('btnStartSign').disabled = true; $('btnStopSign').disabled = false;
    signGestureLabel.textContent = 'Starting camera…';
    try {
      state.signStream = await navigator.mediaDevices.getUserMedia({ video: { width:{ideal:640}, height:{ideal:480}, facingMode:'user' } });
      signVideo.srcObject = state.signStream;
      await signVideo.play();
      signVideo.addEventListener('loadedmetadata', () => { signCanvas.width=signVideo.videoWidth; signCanvas.height=signVideo.videoHeight; }, { once:true });
      state.signRunning = true;
      signGestureLabel.textContent = 'Show your hand…';
      startSignHandsDetection();
    } catch (err) {
      UI.Toast.error('Camera denied: ' + err.message);
      $('btnStartSign').disabled = false; $('btnStopSign').disabled = true;
      signGestureLabel.textContent = 'Camera access denied';
    }
  }

  function stopSignCapture() {
    state.signRunning = false;
    if (state.handsInstance) { try { state.handsInstance.close(); } catch {} state.handsInstance = null; }
    if (state.cameraUtil)    { try { state.cameraUtil.stop(); }     catch {} state.cameraUtil = null; }
    if (state.signStream)    { state.signStream.getTracks().forEach(t=>t.stop()); state.signStream = null; }
    signVideo.srcObject = null;
    const ctx = signCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0,0,signCanvas.width,signCanvas.height);
    signGestureLabel.textContent = 'Point camera at your hand';
    signConfFill.style.width = '0%'; signConfPct.textContent = '0%';
    $('btnStartSign').disabled = false; $('btnStopSign').disabled = true;
  }

  function startSignHandsDetection() {
    if (typeof Hands === 'undefined') { UI.Toast.error('MediaPipe not loaded. Check internet.'); return; }
    state.handsInstance = new Hands({ locateFile: f=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
    state.handsInstance.setOptions({ maxNumHands:1, modelComplexity:1, minDetectionConfidence:0.65, minTrackingConfidence:0.5 });
    state.handsInstance.onResults(onSignResults);
    state.cameraUtil = new Camera(signVideo, { onFrame: async () => { if (!state.signRunning) return; await state.handsInstance.send({ image: signVideo }); }, width:640, height:480 });
    state.cameraUtil.start();
  }

  function onSignResults(results) {
    const ctx = signCanvas.getContext('2d');
    GestureEngine.clearCanvas(ctx, signCanvas.width, signCanvas.height);
    if (!results.multiHandLandmarks?.length) { signGestureLabel.textContent = 'No hand detected'; signConfFill.style.width='0%'; signConfPct.textContent='0%'; return; }
    const lm = results.multiHandLandmarks[0];
    GestureEngine.drawHandOnCanvas(ctx, lm, signCanvas.width, signCanvas.height, true);
    const result = GestureEngine.processFrame(lm);
    if (!result) return;
    const pct = Math.round(result.confidence * 100);
    signGestureLabel.textContent = result.name === '…' ? 'Detecting…' : `✋ ${result.name}`;
    signConfFill.style.width = pct + '%'; signConfPct.textContent = pct + '%';
    if (result.emit && result.name && result.name !== '…') {
      addSignWord(result.name);
      SpeechEngine.speak(result.name, { lang:'en-US' });
    }
  }

  function addSignWord(word) {
    state.signWords.push(word);
    renderSignQueue();
    $('btnSendSign').disabled = false;
  }

  function clearSignWords() {
    state.signWords = [];
    renderSignQueue();
    $('btnSendSign').disabled = true;
  }

  function renderSignQueue() {
    if (!state.signWords.length) {
      signWordQueue.innerHTML = '<span style="color:var(--color-text-3);font-size:0.82rem">Detected words appear here…</span>';
      return;
    }
    signWordQueue.innerHTML = state.signWords.map((w,i) =>
      `<span class="sign-word" data-idx="${i}" role="button" tabindex="0">${escHtml(w)} ×</span>`).join('');
    signWordQueue.querySelectorAll('.sign-word').forEach(el => {
      el.addEventListener('click', () => { state.signWords.splice(+el.dataset.idx,1); renderSignQueue(); $('btnSendSign').disabled = !state.signWords.length; });
    });
  }

  // ── Emoji picker ──────────────────────────────────────────────
  let emojiLoaded = {};
  function buildEmojiTabs() {
    const tabs = $('emojiTabs'); tabs.innerHTML = '';
    UI.Emoji.categories.forEach((cat,i) => {
      const btn = document.createElement('button');
      btn.className = `emoji-tab${i===0?' active':''}`;
      btn.textContent = cat.icon; btn.title = cat.name;
      btn.addEventListener('click', () => { tabs.querySelectorAll('.emoji-tab').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); loadEmojiCat(cat.name); });
      tabs.appendChild(btn);
    });
    loadEmojiCat(UI.Emoji.categories[0].name);
  }
  function loadEmojiCat(name) {
    if (!emojiLoaded[name]) emojiLoaded[name] = UI.Emoji.getCategoryEmojis(name);
    renderEmojiGrid(emojiLoaded[name]);
  }
  function renderEmojiGrid(emojis) {
    const grid = $('emojiGrid');
    grid.innerHTML = emojis.slice(0,80).map(e=>`<button class="emoji-btn" aria-label="${e}">${e}</button>`).join('');
    grid.querySelectorAll('.emoji-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const s=msgInput.selectionStart, end=msgInput.selectionEnd;
        msgInput.value = msgInput.value.slice(0,s) + btn.textContent + msgInput.value.slice(end);
        msgInput.selectionStart = msgInput.selectionEnd = s + btn.textContent.length;
        btnSend.disabled = !msgInput.value.trim();
        emojiPicker.classList.remove('open');
        msgInput.focus();
      });
    });
  }
  $('btnEmojiToggle').addEventListener('click', () => {
    const open = emojiPicker.classList.toggle('open');
    $('btnEmojiToggle').setAttribute('aria-expanded', open);
    if (open && !$('emojiTabs').children.length) buildEmojiTabs();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#emojiPicker') && !e.target.closest('#btnEmojiToggle')) emojiPicker.classList.remove('open');
  });
  $('btnAttach').addEventListener('click', () => UI.Toast.info('File sharing coming soon 📎'));

  function escHtml(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Call functions ─────────────────────────────────────────────
  function startCall(contactId, contact, mode) {
    // Room ID = sorted user IDs (same as call.js uses)
    const myId = currentUser._id || currentUser.id;
    const roomId = [myId, contactId].sort().join(':');

    // Ring the contact
    socket.emit('call:ring', {
      contactId,
      roomId,
      callerName: currentUser.name,
      callMode: mode,
    });

    UI.Toast.info(`📞 Calling ${contact.name}…`);

    // Navigate to call page
    window.location.href = `call.html?cid=${contactId}&mode=${mode}`;
  }

  let _incomingCallRoomId = null;

  function showIncomingCall(roomId, callMode, caller) {
    _incomingCallRoomId = roomId;
    // Remove old banner if any
    const old = document.getElementById('incomingCallBanner');
    if (old) old.remove();

    const banner = document.createElement('div');
    banner.id = 'incomingCallBanner';
    banner.style.cssText = `
      position:fixed; top:16px; left:50%; transform:translateX(-50%);
      background:#1e2a35; border:2px solid #4f8ef7; border-radius:16px;
      padding:16px 24px; z-index:9999; display:flex; align-items:center;
      gap:16px; box-shadow:0 8px 32px rgba(0,0,0,.6); min-width:320px;
      animation: slideDown .3s ease;
    `;
    banner.innerHTML = `
      <style>@keyframes slideDown{from{transform:translateX(-50%) translateY(-40px);opacity:0}to{transform:translateX(-50%) translateY(0);opacity:1}}</style>
      <div style="font-size:2rem;animation:ring 1s infinite">📹</div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:1rem;color:#e9edef">${escHtml(caller.name)}</div>
        <div style="font-size:0.8rem;color:#8696a0">Incoming ${callMode === 'voice' ? '🎙 Voice' : '📹 Video'} Call…</div>
      </div>
      <button id="btnRejectCall"  style="background:rgba(241,92,109,.2);border:1.5px solid #f15c6d;color:#f15c6d;border-radius:10px;padding:8px 16px;cursor:pointer;font-weight:600">Decline</button>
      <button id="btnAcceptCall"  style="background:#4f8ef7;border:none;color:#fff;border-radius:10px;padding:8px 16px;cursor:pointer;font-weight:600">Accept 📞</button>
      <style>@keyframes ring{0%,100%{transform:rotate(-15deg)}50%{transform:rotate(15deg)}}</style>
    `;
    document.body.appendChild(banner);

    // Play ringtone
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = (freq, start, dur) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = freq; g.gain.value = 0.15;
        o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + dur);
      };
      [0, 0.5, 1, 1.5].forEach(t => beep(880, t, 0.3));
    } catch {}

    document.getElementById('btnAcceptCall').onclick = () => {
      dismissIncomingCallUI();
      const callerId = caller.id || caller._id;
      window.location.href = `call.html?cid=${callerId}&mode=${callMode}`;
    };

    document.getElementById('btnRejectCall').onclick = () => {
      dismissIncomingCallUI();
      socket.emit('call:reject', {
        contactId: caller.id || caller._id,
        roomId,
      });
    };

    // Auto-dismiss after 30 seconds
    setTimeout(() => dismissIncomingCallUI(), 30000);
  }

  function dismissIncomingCallUI() {
    const banner = document.getElementById('incomingCallBanner');
    if (banner) banner.remove();
    _incomingCallRoomId = null;
  }

  // Auto-refresh contacts every 30s
  setInterval(refreshContactList, 30000);

  // ── New Nav Rail Handlers ───────────────────────────────────────
  const railFeed = $('railFeed');
  const railChats = $('railChats');
  const railExplore = $('railExplore');
  const feedSection = $('feedSection');
  const exploreSection = $('exploreSection');
  const chatsSection = $('chatsSection');

  function switchToSection(section) {
    // Update rail buttons
    document.querySelectorAll('.rail-btn[data-rail]').forEach(btn => {
      btn.classList.remove('active');
    });
    if (section === 'feed') railFeed.classList.add('active');
    if (section === 'chats') railChats.classList.add('active');
    if (section === 'explore') railExplore.classList.add('active');

    // Update sections
    feedSection.classList.toggle('hidden', section !== 'feed');
    chatsSection.classList.toggle('hidden', section !== 'chats');
    exploreSection.classList.toggle('hidden', section !== 'explore');

    // Load content if needed
    if (section === 'feed') loadFeed();
    if (section === 'explore') loadExplore();
  }

  railFeed.addEventListener('click', () => switchToSection('feed'));
  railChats.addEventListener('click', () => switchToSection('chats'));
  railExplore.addEventListener('click', () => switchToSection('explore'));

  // ── Feed Functions ─────────────────────────────────────────────
  let posts = [];

  async function loadFeed() {
    const feedContent = $('feedContent');
    feedContent.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-3)">Loading feed…</div>';
    try {
      posts = await API.Posts.getFeed();
      renderFeed();
      loadStories();
    } catch (err) {
      UI.Toast.error('Could not load feed: ' + err.message);
      feedContent.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-desc">Could not load feed</p></div>`;
    }
  }

  function renderFeed() {
    const feedContent = $('feedContent');
    if (!posts.length) {
      feedContent.innerHTML = `<div class="empty-state">
        <div class="empty-icon">📰</div>
        <div class="empty-title">No posts yet</div>
        <p class="empty-desc">Follow people or create your first post!</p>
      </div>`;
      return;
    }
    feedContent.innerHTML = posts.map(post => renderPost(post)).join('');
    attachPostEvents();
  }

  function renderPost(post) {
    const isLiked = post.likes?.some(id => String(id) === String(currentUser._id));
    const likeCount = post.likes?.length || 0;
    return `<div class="post-card" data-post-id="${post._id}">
      <div class="post-header">
        <div class="contact-avatar-wrap">
          <div class="avatar avatar-md" style="background:${post.authorId?.avatarColor || 'var(--color-primary)'}">
            ${API.Format.initials(post.authorId?.name || '?')}
          </div>
        </div>
        <div class="post-author">
          <div class="post-author-name">${escHtml(post.authorId?.name || 'Unknown')}</div>
          <div class="post-time">${API.Format.relativeTime(post.createdAt)}</div>
        </div>
      </div>
      ${post.signLabel ? `<div class="post-content"><div class="post-sign-label">✋ ${escHtml(post.signLabel)}</div>${escHtml(post.content)}</div>` : `<div class="post-content">${escHtml(post.content)}</div>`}
      <div class="post-actions">
        <button class="post-action like-btn ${isLiked ? 'liked' : ''}">
          ❤️ <span class="like-count">${likeCount}</span>
        </button>
        <button class="post-action comment-btn">💬 Comment</button>
      </div>
      <div class="post-comments" style="display:none;"></div>
    </div>`;
  }

  function attachPostEvents() {
    document.querySelectorAll('.like-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const postId = btn.closest('.post-card').dataset.postId;
        try {
          const updatedPost = await API.Posts.toggleLike(postId);
          posts = posts.map(p => p._id === updatedPost._id ? updatedPost : p);
          renderFeed();
        } catch (err) {
          UI.Toast.error('Could not like post: ' + err.message);
        }
      });
    });

    document.querySelectorAll('.comment-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const postCard = btn.closest('.post-card');
        const commentsDiv = postCard.querySelector('.post-comments');
        const postId = postCard.dataset.postId;
        if (commentsDiv.style.display === 'block') {
          commentsDiv.style.display = 'none';
          return;
        }
        commentsDiv.style.display = 'block';
        try {
          const comments = await API.Comments.getForPost(postId);
          commentsDiv.innerHTML = comments.map(c => `<div class="comment-item">
            <div class="avatar avatar-sm" style="background:${c.authorId?.avatarColor || 'var(--color-primary)'}">${API.Format.initials(c.authorId?.name || '?')}</div>
            <div class="comment-content">
              <span class="comment-author">${escHtml(c.authorId?.name || 'Unknown')}</span>
              <span class="comment-text">${escHtml(c.content)}</span>
            </div>
          </div>`).join('') + `<div class="add-comment">
            <input type="text" placeholder="Write a comment…" class="comment-input">
            <button class="send-comment-btn">Post</button>
          </div>`;
          const sendBtn = commentsDiv.querySelector('.send-comment-btn');
          const input = commentsDiv.querySelector('.comment-input');
          sendBtn.addEventListener('click', async () => {
            const content = input.value.trim();
            if (!content) return;
            try {
              await API.Comments.create(postId, content);
              const comments = await API.Comments.getForPost(postId);
              commentsDiv.innerHTML = comments.map(c => `<div class="comment-item">
                <div class="avatar avatar-sm" style="background:${c.authorId?.avatarColor || 'var(--color-primary)'}">${API.Format.initials(c.authorId?.name || '?')}</div>
                <div class="comment-content">
                  <span class="comment-author">${escHtml(c.authorId?.name || 'Unknown')}</span>
                  <span class="comment-text">${escHtml(c.content)}</span>
                </div>
              </div>`).join('') + `<div class="add-comment">
                <input type="text" placeholder="Write a comment…" class="comment-input">
                <button class="send-comment-btn">Post</button>
              </div>`;
              UI.Toast.success('Comment posted!');
            } catch (err) {
              UI.Toast.error('Could not post comment: ' + err.message);
            }
          });
        } catch (err) {
          UI.Toast.error('Could not load comments: ' + err.message);
        }
      });
    });
  }

  // ── Stories ─────────────────────────────────────────────────
  async function loadStories() {
    const storiesBar = $('storiesBar');
    try {
      const stories = await API.Stories.get();
      if (!stories.length) {
        storiesBar.style.display = 'none';
        return;
      }
      storiesBar.style.display = 'flex';
      storiesBar.innerHTML = stories.map(story => `<div class="story-item">
        <div class="story-ring">
          <div class="story-avatar" style="background:${story.authorId?.avatarColor || 'var(--color-primary)'}">
            ${story.type === 'sign' ? '✋' : story.type === 'image' ? '🖼️' : '💬'}
          </div>
        </div>
        <div class="story-name">${escHtml(story.authorId?.name || 'Unknown')}</div>
      </div>`).join('');
    } catch (err) {
      storiesBar.style.display = 'none';
    }
  }

  // ── Create Post Modal ───────────────────────────────────────
  const createPostModal = $('createPostModal');
  $('btnCreatePost').addEventListener('click', () => UI.Modal.open(createPostModal));
  $('createPostClose').addEventListener('click', () => UI.Modal.close(createPostModal));
  $('btnSubmitPost').addEventListener('click', async () => {
    const content = $('postContent').value.trim();
    if (!content) {
      UI.Toast.warning('Please write something');
      return;
    }
    try {
      const post = await API.Posts.create({ content, type: 'text' });
      posts.unshift(post);
      renderFeed();
      $('postContent').value = '';
      UI.Modal.close(createPostModal);
      UI.Toast.success('Post created!');
    } catch (err) {
      UI.Toast.error('Could not create post: ' + err.message);
    }
  });

  // ── Create Story Modal ───────────────────────────────────────
  const createStoryModal = $('createStoryModal');
  $('btnCreateStory').addEventListener('click', () => UI.Modal.open(createStoryModal));
  $('createStoryClose').addEventListener('click', () => UI.Modal.close(createStoryModal));
  $('btnSubmitStory').addEventListener('click', async () => {
    const content = $('storyContent').value.trim();
    if (!content) {
      UI.Toast.warning('Please write something');
      return;
    }
    try {
      await API.Stories.create({ content, type: 'text' });
      loadStories();
      $('storyContent').value = '';
      UI.Modal.close(createStoryModal);
      UI.Toast.success('Story shared!');
    } catch (err) {
      UI.Toast.error('Could not share story: ' + err.message);
    }
  });

  // ── Explore Functions ────────────────────────────────────────
  async function loadExplore(query = '') {
    const exploreContent = $('exploreContent');
    exploreContent.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-3)">Loading users…</div>';
    try {
      const users = await API.Explore.getUsers(query);
      const following = await API.Follow.getFollowing();
      const followingIds = new Set(following.map(u => u._id || u.id));
      renderExplore(users, followingIds);
    } catch (err) {
      UI.Toast.error('Could not load users: ' + err.message);
      exploreContent.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><p class="empty-desc">Could not load users</p></div>`;
    }
  }

  function renderExplore(users, followingIds) {
    const exploreContent = $('exploreContent');
    if (!users.length) {
      exploreContent.innerHTML = `<div class="empty-state">
        <div class="empty-icon">👥</div>
        <div class="empty-title">No users found</div>
        <p class="empty-desc">Try a different search term</p>
      </div>`;
      return;
    }
    exploreContent.innerHTML = `<div class="explore-users">${users.map(user => renderUserCard(user, followingIds.has(user._id || user.id))).join('')}</div>`;
    attachExploreEvents();
  }

  function renderUserCard(user, isFollowing) {
    const typeEmoji = { deaf: '🦻', mute: '🤐', deafmute: '🤟', hearing: '👂' };
    return `<div class="user-card" data-user-id="${user._id || user.id}">
      <div class="user-card-avatar" style="background:${user.avatarColor || 'var(--color-primary)'}">
        ${API.Format.initials(user.name)}
      </div>
      <div class="user-card-name">${escHtml(user.name)}</div>
      <div class="user-card-username">@${escHtml(user.username)}</div>
      <div class="user-card-type">${typeEmoji[user.userType] || '👤'} ${escHtml(user.userType)}</div>
      ${user.bio ? `<div class="user-card-bio">${escHtml(user.bio)}</div>` : ''}
      <button class="btn ${isFollowing ? 'btn-secondary' : 'btn-primary'} btn-sm follow-btn" data-user-id="${user._id || user.id}">
        ${isFollowing ? 'Unfollow' : 'Follow'}
      </button>
    </div>`;
  }

  function attachExploreEvents() {
    document.querySelectorAll('.follow-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = btn.dataset.userId;
        const isFollowing = btn.textContent.trim() === 'Unfollow';
        btn.disabled = true;
        try {
          if (isFollowing) {
            await API.Follow.unfollow(userId);
            btn.textContent = 'Follow';
            btn.classList.remove('btn-secondary');
            btn.classList.add('btn-primary');
          } else {
            await API.Follow.follow(userId);
            btn.textContent = 'Unfollow';
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-secondary');
          }
          UI.Toast.success(isFollowing ? 'Unfollowed' : 'Followed!');
        } catch (err) {
          UI.Toast.error('Action failed: ' + err.message);
        }
        btn.disabled = false;
      });
    });
  }

  $('exploreSearch').addEventListener('input', UI.debounce(function(e) {
    loadExplore((e.target || this || {}).value || '');
  }, 300));

  // ── Sign Display Panel (Speech to Sign) ────────────────────────────────────────
  const signDisplayPanel = $('signDisplayPanel');
  const btnSignDisplayToggle = $('btnSignDisplayToggle');
  const btnStartSpeech = $('btnStartSpeech');
  const btnStopSpeech = $('btnStopSpeech');
  const btnCloseSignDisplay = $('btnCloseSignDisplay');
  const signAvatar = $('signAvatar');
  const signDisplayLabel = $('signDisplayLabel');
  const signDisplayText = $('signDisplayText');

  let speechRecognition = null;
  let isListening = false;

  // Sign language dictionary (simple emoji-based for demonstration)
  const signDict = {
    'hello': '👋',
    'hi': '👋',
    'thank': '🙏',
    'thanks': '🙏',
    'yes': '👍',
    'no': '👎',
    'love': '❤️',
    'bye': '👋',
    'goodbye': '👋',
    'help': '🙋',
    'friend': '🤝',
    'please': '🙏',
    'sorry': '😔',
    'happy': '😊',
    'sad': '😢',
    'home': '🏠',
    'eat': '🍔',
    'drink': '🥤',
    'water': '💧',
    'book': '📖',
    'school': '🏫',
    'work': '💼',
    'play': '🎮',
    'music': '🎵',
    'dance': '💃',
    'see': '👀',
    'you': '👉',
    'i': '👆',
    'me': '👆',
    'we': '👥',
    'they': '👥',
    'how': '❓',
    'what': '❓',
    'when': '⏰',
    'where': '📍',
    'why': '❓',
    'stop': '✋',
    'go': '🏃',
    'come': '🏃',
    'wait': '⏳',
    'good': '👍',
    'bad': '👎',
    'big': '📏',
    'small': '📏',
    'more': '➕',
    'less': '➖',
    'one': '1️⃣',
    'two': '2️⃣',
    'three': '3️⃣',
    'four': '4️⃣',
    'five': '5️⃣',
    'six': '6️⃣',
    'seven': '7️⃣',
    'eight': '8️⃣',
    'nine': '9️⃣',
    'ten': '🔟',
    'a': '🅰️',
    'b': '🅱️',
    'c': '©️',
    'd': '🇩',
    'e': '🇪',
    'f': '🇫',
    'g': '🇬',
    'h': '🇭',
    'i': '🇮',
    'j': '🇯',
    'k': '🇰',
    'l': '🇱',
    'm': '🇲',
    'n': '🇳',
    'o': '🅾️',
    'p': '🇵',
    'q': '🇶',
    'r': '🇷',
    's': '🇸',
    't': '🇹',
    'u': '🇺',
    'v': '🇻',
    'w': '🇼',
    'x': '❌',
    'y': '🇾',
    'z': '🇿'
  };

  function toggleSignDisplayPanel(open) {
    if (open) {
      signDisplayPanel.classList.add('open');
      btnSignDisplayToggle.classList.add('active');
      btnSignDisplayToggle.setAttribute('aria-pressed', 'true');
    } else {
      signDisplayPanel.classList.remove('open');
      btnSignDisplayToggle.classList.remove('active');
      btnSignDisplayToggle.setAttribute('aria-pressed', 'false');
      stopListening();
    }
  }

  function updateSignDisplay(word) {
    const clean = word.toLowerCase().replace(/[^a-z0-9]/g, '');
    const emoji = signDict[clean] || '🤖';
    signAvatar.textContent = emoji;
    signAvatar.style.transform = 'scale(1.2)';
    setTimeout(() => {
      signAvatar.style.transform = 'scale(1)';
    }, 300);
    signDisplayLabel.textContent = word;
    signDisplayText.textContent = word;
  }

  function initSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      UI.Toast.error('Speech recognition is not supported in this browser');
      return null;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    return rec;
  }

  function startListening() {
    speechRecognition = initSpeechRecognition();
    if (!speechRecognition) return;
    isListening = true;
    btnStartSpeech.disabled = true;
    btnStopSpeech.disabled = false;
    signDisplayLabel.textContent = 'Listening...';
    speechRecognition.onresult = (event) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        }
      }
      if (finalTranscript.trim()) {
        const words = finalTranscript.trim().split(/\s+/);
        const lastWord = words[words.length - 1];
        updateSignDisplay(lastWord);
      }
    };
    speechRecognition.onerror = (event) => {
      UI.Toast.error(`Speech recognition error: ${event.error}`);
      stopListening();
    };
    speechRecognition.onend = () => {
      if (isListening) {
        try { speechRecognition.start(); } catch(e) {}
      }
    };
    try { speechRecognition.start(); } catch(e) { UI.Toast.error('Failed to start speech recognition'); }
  }

  function stopListening() {
    isListening = false;
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch(e) {}
      speechRecognition = null;
    }
    btnStartSpeech.disabled = false;
    btnStopSpeech.disabled = true;
    signDisplayLabel.textContent = 'Start listening to see signs';
    signDisplayText.textContent = '';
  }

  btnSignDisplayToggle.addEventListener('click', () => {
    const isOpen = signDisplayPanel.classList.contains('open');
    toggleSignDisplayPanel(!isOpen);
  });

  btnCloseSignDisplay.addEventListener('click', () => toggleSignDisplayPanel(false));
  btnStartSpeech.addEventListener('click', startListening);
  btnStopSpeech.addEventListener('click', stopListening);

})();

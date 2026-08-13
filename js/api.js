/**
 * SignCall — API Client
 * api.js
 *
 * ALL data comes from the server (MongoDB Atlas).
 * localStorage stores ONLY the JWT token — nothing else.
 * No user data, no messages, no contacts stored in browser.
 *
 * Every page load fetches fresh data from the server.
 */

const API = (() => {
  'use strict';

  // ── Only the JWT token lives in localStorage ─────────────────
  // This is standard practice — the token proves identity.
  // All actual data is on the server.
  const TOKEN_KEY = 'sc_jwt';

  function getToken()       { return localStorage.getItem(TOKEN_KEY); }
  function saveToken(t)     { localStorage.setItem(TOKEN_KEY, t); }
  function removeToken()    { localStorage.removeItem(TOKEN_KEY); }
  function isLoggedIn()     { return !!getToken(); }

  // ── Base URL — same origin as the page ───────────────────────
  // Works on EC2: http://your-ip:5001
  // Works on localhost: http://localhost:5001
  const BASE = window.location.origin;

  // ── Core HTTP fetch wrapper ───────────────────────────────────
  async function request(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    let res;
    try {
      res = await fetch(`${BASE}${path}`, options);
    } catch (networkErr) {
      throw new Error('Cannot reach server. Check your connection.');
    }

    // Token expired or invalid → force logout
    if (res.status === 401) {
      removeToken();
      window.location.href = 'index.html';
      throw new Error('Session expired. Please sign in again.');
    }

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok) {
      const err = new Error(data.error || `Server error (${res.status})`);
      err.status = res.status;
      err.field  = data.field || null;
      throw err;
    }
    return data;
  }

  const get  = path        => request('GET',    path);
  const post = (path, body) => request('POST',   path, body);
  const patch= (path, body) => request('PATCH',  path, body);
  const del  = path        => request('DELETE',  path);

  // ══════════════════════════════════════════════════════════════
  //  AUTH  — all data stored in MongoDB, token only in browser
  // ══════════════════════════════════════════════════════════════
  const Auth = {

    // Sign up → server creates user in MongoDB → returns JWT
    async signup({ name, email, username, password, confirmPassword, userType }) {
      if (password !== confirmPassword) {
        const e = new Error('Passwords do not match');
        e.field = 'confirmPassword';
        throw e;
      }
      const data = await request('POST', '/api/auth/signup',
        { name, email, username, password, userType });
      saveToken(data.token);   // ← only token saved to browser
      return data.user;        // ← user object from MongoDB
    },

    // Login → server verifies against MongoDB → returns JWT
    async login({ email, password }) {
      const data = await request('POST', '/api/auth/login', { email, password });
      saveToken(data.token);
      return data.user;
    },

    // Logout — just remove the token, nothing else to clear
    logout() {
      removeToken();
      window.location.href = 'index.html';
    },

    // Get current user from SERVER (not from localStorage)
    async me() {
      const data = await get('/api/auth/me');
      return data.user;   // fresh from MongoDB every time
    },

    // Update profile on server
    async updateProfile(updates) {
      const data = await patch('/api/auth/profile', updates);
      return data.user;
    },

    // Guard: redirect to login if no token
    // Returns null and redirects if not logged in.
    // Returns basic info decoded from JWT (just for immediate use).
    requireAuth() {
      if (!isLoggedIn()) {
        window.location.href = 'index.html';
        return null;
      }
      // Decode JWT payload (base64) to get userId without a server call.
      // This is just for the initial render — real data always fetched from server.
      try {
        const payload = JSON.parse(atob(getToken().split('.')[1]));
        return { id: payload.id, _id: payload.id };
      } catch {
        removeToken();
        window.location.href = 'index.html';
        return null;
      }
    },

    redirectIfLoggedIn(dest = 'app.html') {
      if (isLoggedIn()) window.location.href = dest;
    },

    isLoggedIn,
    getToken,
  };

  // ══════════════════════════════════════════════════════════════
  //  USERS  — search/find users on server
  // ══════════════════════════════════════════════════════════════
  const Users = {
    // Search MongoDB for users by name/username/email
    async search(query) {
      if (!query || query.length < 2) return [];
      const data = await get(`/api/users/search?q=${encodeURIComponent(query)}`);
      return data.users || [];
    },

    async getById(id) {
      const data = await get(`/api/users/${id}`);
      return data.user;
    },
  };

  // ══════════════════════════════════════════════════════════════
  //  CONTACTS  — stored in MongoDB contacts collection
  // ══════════════════════════════════════════════════════════════
  const Contacts = {
    // Returns contacts of the logged-in user from MongoDB
    async getAll() {
      const data = await get('/api/contacts');
      return data.contacts || [];
    },

    // Adds contact to MongoDB (both directions)
    async add(contactId) {
      const data = await post('/api/contacts', { contactId });
      return data.contact;
    },

    async remove(contactId) {
      await del(`/api/contacts/${contactId}`);
    },
  };

  // ══════════════════════════════════════════════════════════════
  //  MESSAGES  — stored in MongoDB messages collection
  // ══════════════════════════════════════════════════════════════
  const Messages = {
    // Fetches message history from MongoDB
    async getConversation(contactId, page = 1) {
      const data = await get(`/api/messages/${contactId}?page=${page}&limit=50`);
      return data.messages || [];
    },

    // Saves message to MongoDB
    async send(toId, content, type = 'text', signLabel = '') {
      const data = await post('/api/messages', { toId, content, type, signLabel });
      return data.message;
    },

    async unreadCount() {
      const data = await get('/api/messages/unread/count');
      return data.count || 0;
    },
  };

  // ══════════════════════════════════════════════════════════════
  //  FORMAT HELPERS
  // ══════════════════════════════════════════════════════════════
  const Format = {
    initials(name) {
      if (!name) return '?';
      return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
    },
    time(ts) {
      if (!ts) return '';
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },
    relativeTime(ts) {
      if (!ts) return '';
      const diff = Date.now() - new Date(ts).getTime();
      if (diff < 60000)    return 'just now';
      if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
    },
    msgPreview(msg) {
      if (!msg) return '';
      if (msg.type === 'sign')  return `✋ ${msg.content}`;
      if (msg.type === 'voice') return '🎙 Voice note';
      const c = msg.content || '';
      return c.length > 42 ? c.slice(0, 42) + '…' : c;
    },
    duration(s) {
      const m = Math.floor(s / 60), sec = s % 60;
      return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    },
  };

  // ══════════════════════════════════════════════════════════════
  //  SOCIAL MEDIA - Follow, Posts, Comments, Stories, Explore
  // ══════════════════════════════════════════════════════════════
  const Follow = {
    async follow(userId) {
      await post(`/api/follow/${userId}`);
    },
    async unfollow(userId) {
      await del(`/api/follow/${userId}`);
    },
    async getFollowers(userId) {
      const data = await get(userId ? `/api/followers/${userId}` : '/api/followers');
      return data.followers || [];
    },
    async getFollowing(userId) {
      const data = await get(userId ? `/api/following/${userId}` : '/api/following');
      return data.following || [];
    },
  };

  const Posts = {
    async create(data) {
      const res = await post('/api/posts', data);
      return res.post;
    },
    async getFeed(page = 1) {
      const data = await get(`/api/posts?page=${page}`);
      return data.posts || [];
    },
    async getUserPosts(userId, page = 1) {
      const data = await get(`/api/posts/user/${userId}?page=${page}`);
      return data.posts || [];
    },
    async toggleLike(postId) {
      const res = await post(`/api/posts/${postId}/like`);
      return res.post;
    },
  };

  const Comments = {
    async create(postId, content) {
      const res = await post(`/api/posts/${postId}/comments`, { content });
      return res.comment;
    },
    async getForPost(postId) {
      const data = await get(`/api/posts/${postId}/comments`);
      return data.comments || [];
    },
  };

  const Stories = {
    async create(data) {
      const res = await post('/api/stories', data);
      return res.story;
    },
    async get() {
      const data = await get('/api/stories');
      return data.stories || [];
    },
  };

  const Explore = {
    async getUsers(query = '', page = 1) {
      const q = query ? `&q=${encodeURIComponent(query)}` : '';
      const data = await get(`/api/explore?page=${page}${q}`);
      return data.users || [];
    },
  };

  return { Auth, Users, Contacts, Messages, Follow, Posts, Comments, Stories, Explore, Format, getToken, isLoggedIn };

})();

window.API = API;

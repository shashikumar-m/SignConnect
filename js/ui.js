/**
 * SignConnect — Shared UI Utilities
 * ui.js
 *
 * Toast notifications, modals, format helpers, router utilities.
 */

const UI = (() => {

  // ── Toast notifications ───────────────────────────────────────
  const Toast = (() => {
    let container = null;

    const getContainer = () => {
      if (!container) {
        container = document.getElementById('toast-container');
        if (!container) {
          container = document.createElement('div');
          container.id = 'toast-container';
          document.body.appendChild(container);
        }
      }
      return container;
    };

    const icons = {
      success: '✓',
      error:   '✕',
      warning: '⚠',
      info:    'ℹ',
    };

    const show = (message, type = 'info', duration = 3500) => {
      const c = getContainer();
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span>${message}</span>
      `;
      c.appendChild(toast);

      const dismiss = () => {
        toast.classList.add('out');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
      };

      toast.addEventListener('click', dismiss);
      if (duration > 0) setTimeout(dismiss, duration);
      return dismiss;
    };

    return {
      success: (msg, d) => show(msg, 'success', d),
      error:   (msg, d) => show(msg, 'error', d),
      warning: (msg, d) => show(msg, 'warning', d),
      info:    (msg, d) => show(msg, 'info', d),
    };
  })();

  // ── Modal ─────────────────────────────────────────────────────
  const Modal = (() => {
    const openModal = (backdropEl) => {
      if (!backdropEl) return;
      backdropEl.classList.remove('hidden');
      backdropEl.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      // Focus first focusable element
      const focusable = backdropEl.querySelector('input, button, select, textarea');
      if (focusable) setTimeout(() => focusable.focus(), 100);
      // Close on backdrop click
      backdropEl.addEventListener('click', (e) => {
        if (e.target === backdropEl) closeModal(backdropEl);
      }, { once: true });
    };

    const closeModal = (backdropEl) => {
      if (!backdropEl) return;
      backdropEl.classList.add('hidden');
      backdropEl.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    };

    const toggle = (backdropEl) => {
      if (backdropEl.classList.contains('hidden')) openModal(backdropEl);
      else closeModal(backdropEl);
    };

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const open = document.querySelector('.modal-backdrop:not(.hidden)');
        if (open) closeModal(open);
      }
    });

    return { open: openModal, close: closeModal, toggle };
  })();

  // ── Format helpers ────────────────────────────────────────────
  const Format = {
    time(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    date(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = new Date();
      const diff = now - d;
      const day = 86400000;

      if (diff < day && d.getDate() === now.getDate()) return 'Today';
      if (diff < 2 * day) return 'Yesterday';
      return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    },

    relativeTime(ts) {
      if (!ts) return '';
      const diff = Date.now() - ts;
      if (diff < 60000)    return 'just now';
      if (diff < 3600000)  return `${Math.floor(diff/60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
      return Format.date(ts);
    },

    msgPreview(msg) {
      if (!msg) return '';
      if (msg.type === 'sign')  return `✋ ${msg.content}`;
      if (msg.type === 'voice') return '🎙 Voice note';
      return msg.content.length > 40 ? msg.content.slice(0, 40) + '…' : msg.content;
    },

    duration(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    },

    initials(name) {
      if (!name) return '?';
      return name.split(' ').slice(0,2).map(w => w[0]).join('').toUpperCase();
    },
  };

  // ── Avatar ────────────────────────────────────────────────────
  const Avatar = {
    render(user, sizeClass = 'avatar-md') {
      if (!user) return '';
      return `<div class="avatar ${sizeClass}" style="background:${user.avatarColor || '#4f8ef7'}" aria-label="${user.name}">
        ${Format.initials(user.name)}
      </div>`;
    }
  };

  // ── DOM helpers ───────────────────────────────────────────────
  const el    = (id)     => document.getElementById(id);
  const qs    = (sel, root = document) => root.querySelector(sel);
  const qsa   = (sel, root = document) => [...root.querySelectorAll(sel)];

  const setHTML = (id, html) => {
    const e = el(id);
    if (e) e.innerHTML = html;
  };

  const setText = (id, text) => {
    const e = el(id);
    if (e) e.textContent = text;
  };

  const show = (id) => { const e = el(id); if (e) e.classList.remove('hidden'); };
  const hide = (id) => { const e = el(id); if (e) e.classList.add('hidden'); };
  const toggle = (id, force) => { const e = el(id); if (e) e.classList.toggle('hidden', force); };

  // ── Form helpers ──────────────────────────────────────────────
  const Form = {
    values(formEl) {
      const data = {};
      const els = formEl.querySelectorAll('input,select,textarea');
      els.forEach(e => {
        if (e.name) data[e.name] = e.type === 'checkbox' ? e.checked : e.value;
      });
      return data;
    },

    showError(inputEl, msg) {
      if (!inputEl) return;
      inputEl.style.borderColor = 'var(--color-danger)';
      let err = inputEl.parentElement.querySelector('.field-error');
      if (!err) {
        err = document.createElement('div');
        err.className = 'field-error';
        err.style.cssText = 'color:var(--color-danger);font-size:0.75rem;margin-top:4px;';
        inputEl.parentElement.appendChild(err);
      }
      err.textContent = msg;
    },

    clearErrors(formEl) {
      formEl.querySelectorAll('.field-error').forEach(e => e.remove());
      formEl.querySelectorAll('input,select,textarea').forEach(e => e.style.borderColor = '');
    },

    showErrors(formEl, errors) {
      this.clearErrors(formEl);
      Object.entries(errors).forEach(([name, msg]) => {
        const input = formEl.querySelector(`[name="${name}"]`);
        this.showError(input, msg);
      });
    },

    setLoading(btn, loading, originalText) {
      if (loading) {
        btn.disabled = true;
        btn.dataset.originalText = btn.textContent;
        btn.innerHTML = `<span class="animate-spin" style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;display:inline-block;"></span>`;
      } else {
        btn.disabled = false;
        btn.textContent = originalText || btn.dataset.originalText || btn.textContent;
      }
    },
  };

  // ── Skeleton loader ───────────────────────────────────────────
  const Skeleton = {
    contact() {
      return `<div class="contact-item" style="pointer-events:none">
        <div class="skeleton skeleton-circle" style="width:40px;height:40px;flex-shrink:0;"></div>
        <div style="flex:1">
          <div class="skeleton skeleton-text" style="width:60%;"></div>
          <div class="skeleton skeleton-text" style="width:80%;margin-top:6px;"></div>
        </div>
      </div>`;
    },

    contacts(count = 5) {
      return Array.from({length: count}, () => this.contact()).join('');
    }
  };

  // ── Emoji generator from unicode ranges ──────────────────────
  const Emoji = {
    categories: [
      { name: 'Smileys', icon: '😀', ranges: [[0x1F600, 0x1F64F]] },
      { name: 'People',  icon: '👋', ranges: [[0x1F466, 0x1F4FF],[0x1F9D0, 0x1F9EF]] },
      { name: 'Nature',  icon: '🌿', ranges: [[0x1F400, 0x1F43F],[0x1F330, 0x1F37F]] },
      { name: 'Food',    icon: '🍎', ranges: [[0x1F345, 0x1F37F],[0x1F950, 0x1F9C0]] },
      { name: 'Travel',  icon: '🚀', ranges: [[0x1F680, 0x1F6FF],[0x26F0, 0x26FF]] },
      { name: 'Objects', icon: '💡', ranges: [[0x1F4A0, 0x1F4FF]] },
      { name: 'Symbols', icon: '❤️', ranges: [[0x2600, 0x26FF],[0x2700, 0x27BF]] },
    ],

    fromRange(start, end) {
      const emojis = [];
      for (let cp = start; cp <= end; cp++) {
        try {
          const str = String.fromCodePoint(cp);
          // Basic filter: skip control chars
          if (cp > 0x1F000 || (cp >= 0x2600 && cp <= 0x27BF)) emojis.push(str);
        } catch {}
      }
      return emojis;
    },

    getCategoryEmojis(category) {
      const cat = this.categories.find(c => c.name === category);
      if (!cat) return [];
      return cat.ranges.flatMap(([s, e]) => this.fromRange(s, e)).slice(0, 80);
    },
  };

  // ── Scroll to bottom helper ───────────────────────────────────
  const scrollToBottom = (el, smooth = true) => {
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
  };

  // ── Debounce ──────────────────────────────────────────────────
  const debounce = (fn, wait = 300) => {
    let timer;
    return function(...args) {
      clearTimeout(timer);
      // Preserve the event target before setTimeout loses it
      const ctx = this;
      if (args[0] && args[0].target) {
        // Clone the value so it's available after event pooling
        const val = args[0].target.value;
        const syntheticArg = { target: { value: val } };
        timer = setTimeout(() => fn.apply(ctx, [syntheticArg, ...args.slice(1)]), wait);
      } else {
        timer = setTimeout(() => fn.apply(ctx, args), wait);
      }
    };
  };

  // ── Throttle ─────────────────────────────────────────────────
  const throttle = (fn, limit = 100) => {
    let inThrottle;
    return (...args) => {
      if (!inThrottle) {
        fn(...args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  };

  return {
    Toast, Modal, Format, Avatar, Form, Skeleton, Emoji,
    el, qs, qsa, setHTML, setText, show, hide, toggle,
    scrollToBottom, debounce, throttle,
  };
})();

window.UI = UI;

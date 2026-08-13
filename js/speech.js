/**
 * SignConnect — Speech Engine
 * speech.js
 *
 * Web Speech API: speech-to-text (STT) and text-to-speech (TTS).
 * Used in both the chat sign panel and the video call page.
 */

const SpeechEngine = (() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  let recognition    = null;
  let isListening    = false;
  let onInterimCb    = null;
  let onFinalCb      = null;
  let onErrorCb      = null;
  let onStatusCb     = null;
  let continuousMode = true;
  let lang           = 'en-US';
  let autoRestart    = true;
  let restartTimer   = null;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isSupported = !!SR;

  // ── STT ────────────────────────────────────────────────────
  function startSTT(options = {}) {
    if (!isSupported) {
      if (onErrorCb) onErrorCb('Speech recognition is not supported in this browser. Please use Chrome or Edge.');
      return false;
    }
    if (isListening) stopSTT();

    if (options.lang)       lang           = options.lang;
    if (options.onInterim)  onInterimCb    = options.onInterim;
    if (options.onFinal)    onFinalCb      = options.onFinal;
    if (options.onError)    onErrorCb      = options.onError;
    if (options.onStatus)   onStatusCb     = options.onStatus;
    if (options.continuous !== undefined) continuousMode = options.continuous;
    if (options.autoRestart !== undefined) autoRestart = options.autoRestart;

    recognition = new SR();
    recognition.lang            = lang;
    recognition.continuous      = continuousMode;
    recognition.interimResults  = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isListening = true;
      if (onStatusCb) onStatusCb('listening');
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript + ' ';
        } else {
          interim += transcript;
        }
      }
      if (interim && onInterimCb) onInterimCb(interim);
      if (finalText.trim() && onFinalCb) onFinalCb(finalText.trim());
    };

    recognition.onerror = (event) => {
      const msg = {
        'no-speech':          'No speech detected. Please speak clearly.',
        'audio-capture':      'Microphone not available.',
        'not-allowed':        'Microphone access denied. Please allow microphone permissions.',
        'network':            'Network error. Check your connection.',
        'aborted':            'Speech recognition stopped.',
      }[event.error] || `Error: ${event.error}`;

      isListening = false;
      if (onErrorCb) onErrorCb(msg);
      if (onStatusCb) onStatusCb('error');

      // Auto-restart on recoverable errors
      if (autoRestart && event.error !== 'not-allowed' && event.error !== 'aborted') {
        restartTimer = setTimeout(() => {
          if (!isListening) startSTT();
        }, 1500);
      }
    };

    recognition.onend = () => {
      isListening = false;
      if (onStatusCb) onStatusCb('stopped');
      if (autoRestart && continuousMode) {
        restartTimer = setTimeout(() => {
          if (!isListening) startSTT();
        }, 500);
      }
    };

    try {
      recognition.start();
      return true;
    } catch (e) {
      if (onErrorCb) onErrorCb('Could not start speech recognition: ' + e.message);
      return false;
    }
  }

  function stopSTT() {
    autoRestart = false;
    clearTimeout(restartTimer);
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }
    isListening = false;
    if (onStatusCb) onStatusCb('stopped');
  }

  function setLanguage(newLang) {
    lang = newLang;
    if (isListening) {
      stopSTT();
      autoRestart = true;
      startSTT();
    }
  }

  function isSTTListening() { return isListening; }
  function isSTTSupported() { return isSupported; }

  // ── TTS ────────────────────────────────────────────────────
  const TTS = window.speechSynthesis;
  let ttsEnabled = true;
  let ttsLang    = 'en-US';
  let ttsVoice   = null;
  let ttsRate    = 1.0;
  let ttsPitch   = 1.0;
  let ttsVolume  = 1.0;

  // Load voices (async in some browsers)
  let voices = [];
  function loadVoices() {
    if (!TTS) return;
    voices = TTS.getVoices();
  }
  if (TTS) {
    loadVoices();
    TTS.onvoiceschanged = loadVoices;
  }

  function speak(text, options = {}) {
    if (!TTS || !ttsEnabled || !text) return;
    TTS.cancel(); // stop any current speech

    // Mobile browsers require audio context to be unlocked by a user gesture.
    // We attempt to resume it here — safe to call even on desktop.
    try {
      if (window._ttsAudioCtx && window._ttsAudioCtx.state === 'suspended') {
        window._ttsAudioCtx.resume();
      }
    } catch {}

    const utt = new SpeechSynthesisUtterance(text);
    utt.lang   = options.lang   || ttsLang;
    utt.rate   = options.rate   || ttsRate;
    utt.pitch  = options.pitch  || ttsPitch;
    utt.volume = options.volume !== undefined ? options.volume : ttsVolume;

    // Select a voice that matches the language
    // Prefer a local (on-device) voice for lower latency
    const langCode = utt.lang.slice(0, 2);
    const preferredVoice =
      voices.find(v => v.lang.startsWith(langCode) && v.localService) ||
      voices.find(v => v.lang.startsWith(langCode));

    if (preferredVoice) utt.voice = preferredVoice;
    if (ttsVoice)       utt.voice = ttsVoice;
    if (options.voice)  utt.voice = options.voice;

    if (options.onEnd) utt.onend = options.onEnd;

    // On some mobile browsers speechSynthesis silently fails if voices
    // haven't loaded yet. Retry once after a short delay.
    if (voices.length === 0) {
      loadVoices();
      setTimeout(() => { if (TTS && text) TTS.speak(utt); }, 300);
      return;
    }

    TTS.speak(utt);
  }

  function cancelSpeech() {
    if (TTS) TTS.cancel();
  }

  function getVoices(langFilter) {
    if (!langFilter) return voices;
    return voices.filter(v => v.lang.startsWith(langFilter));
  }

  function setTTSEnabled(val) { ttsEnabled = val; }
  function setTTSVoice(voice)  { ttsVoice = voice; }
  function setTTSRate(rate)    { ttsRate  = rate; }
  function isTTSSupported()    { return !!TTS; }

  // ── Language options ────────────────────────────────────────
  const LANGUAGES = [
    { code: 'en-US', name: 'English (US)' },
    { code: 'en-GB', name: 'English (UK)' },
    { code: 'hi-IN', name: 'Hindi' },
    { code: 'es-ES', name: 'Spanish' },
    { code: 'fr-FR', name: 'French' },
    { code: 'de-DE', name: 'German' },
    { code: 'ja-JP', name: 'Japanese' },
    { code: 'zh-CN', name: 'Chinese (Simplified)' },
    { code: 'ar-SA', name: 'Arabic' },
  ];

  return {
    startSTT,
    stopSTT,
    setLanguage,
    isSTTListening,
    isSTTSupported,
    speak,
    cancelSpeech,
    getVoices,
    setTTSEnabled,
    setTTSVoice,
    setTTSRate,
    isTTSSupported,
    LANGUAGES,
  };

})();

window.SpeechEngine = SpeechEngine;

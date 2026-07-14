/**
 * MAX Voice Assistant - Core Application Logic
 * Implements state machine, Web Speech APIs, and Gemini API integration.
 */

// ==================== CONFIGURATION & STATE ====================
const CONFIG = {
  // Default API Key provided by user
  defaultApiKey: '',
  defaultModel: 'gemini-3.1-flash-lite',
  
  // Language mappings for Speech Recognition & Synthesis
  languages: {
    auto: { code: 'en-IN', name: 'Auto (English/Indian Fallback)' },
    en: { code: 'en-US', name: 'English' },
    ta: { code: 'ta-IN', name: 'Tamil (தமிழ்)' },
    hi: { code: 'hi-IN', name: 'Hindi (हिन्दी)' },
    te: { code: 'te-IN', name: 'Telugu (తెలుగు)' },
    ml: { code: 'ml-IN', name: 'Malayalam (മലയാളം)' }
  }
};

// Force update if old model or overloaded model is stored
if (localStorage.getItem('max_model') === 'gemini-2.5-flash' || localStorage.getItem('max_model') === 'gemini-3.5-flash') {
  localStorage.setItem('max_model', 'gemini-3.1-flash-lite');
}

const STATE = {
  // State Machine: 'sleeping', 'listening', 'processing', 'speaking', 'error'
  current: 'sleeping',
  
  // API Config
  apiKey: localStorage.getItem('max_api_key') || CONFIG.defaultApiKey,
  model: localStorage.getItem('max_model') || CONFIG.defaultModel,
  voiceSpeed: parseFloat(localStorage.getItem('max_voice_speed')) || 1.0,
  
  // Mic Permission Flag
  micPermissionDenied: false,
  
  // Active Conversation Info
  selectedLang: 'auto', // 'auto', 'en', 'ta', 'hi', 'te', 'ml'
  chatHistory: [], // stores { role: 'user'|'model', text: string }
  isOnlineMode: true, // true (Force Online), false (Force Offline)
  
  // Timers and Recognition handles
  wakeWordRecognition: null,
  activeRecognition: null,
  listeningTimeout: null,
  silenceTimeout: null,
  cooldownTimeout: null,
  
  // System variables
  isSpeechActive: false,
  recognitionActive: false,
  activeAudio: null,
  dashboardActive: false,
  speechRestartDelay: 1000
};

// Ensure API key is saved to localStorage if not already there
if (!localStorage.getItem('max_api_key')) {
  localStorage.setItem('max_api_key', CONFIG.defaultApiKey);
}

// ==================== DOM ELEMENTS ====================
const DOM = {
  body: document.body,
  faceContainer: document.getElementById('face-container'),
  dashboardContainer: document.getElementById('dashboard-container'),
  hiddenTrigger: document.getElementById('hidden-dashboard-trigger'),
  dbBackBtn: document.getElementById('db-back-btn'),
  chatMessages: document.getElementById('chat-messages'),
  dbStatusInstruction: document.getElementById('db-status-instruction'),
  faceStatusText: document.getElementById('face-status-text'),
  latencyVal: document.getElementById('latency-val'),
  
  // Control Elements
  modeGroup: document.getElementById('mode-group'),
  langGroup: document.getElementById('lang-group'),
  manualTextInput: document.getElementById('manual-text-input'),
  manualSendBtn: document.getElementById('manual-send-btn'),
  voiceTriggerBtn: document.getElementById('voice-trigger-btn'),
  micIcon: document.getElementById('mic-icon'),
  
  // Settings Elements
  settingsToggle: document.getElementById('settings-toggle'),
  settingsModal: document.getElementById('settings-modal'),
  closeSettingsBtn: document.getElementById('close-settings-btn'),
  settingsApiKey: document.getElementById('settings-api-key'),
  settingsModel: document.getElementById('settings-model'),
  settingsVoiceSpeed: document.getElementById('settings-voice-speed'),
  speedVal: document.getElementById('speed-val'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  langStatus: document.getElementById('lang-status')
};

// ==================== WAKE WORD & AUDIO SOUNDS ====================
// Synthetic tones since we are fully client-side and offline-capable
function playChime(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    const now = ctx.currentTime;
    if (type === 'start') {
      // Ascending double-beep for activation
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      gain.gain.setValueAtTime(0.1, now);
      osc.start(now);
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.15); // G5
      gain.gain.setValueAtTime(0.1, now + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
      osc.stop(now + 0.3);
    } else if (type === 'stop') {
      // Descending beep for deactivation
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      gain.gain.setValueAtTime(0.1, now);
      osc.start(now);
      osc.frequency.exponentialRampToValueAtTime(392.00, now + 0.2); // G4
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
      osc.stop(now + 0.3);
    } else if (type === 'error') {
      // Short buzzy error chime
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, now);
      gain.gain.setValueAtTime(0.1, now);
      osc.start(now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc.stop(now + 0.35);
    }
  } catch (e) {
    console.warn('Audio Context chime failed to play: ', e);
  }
}

// ==================== STATE MANAGEMENT ====================
function transitionTo(stateName) {
  console.log(`[STATE] Transition: ${STATE.current} -> ${stateName}`);
  
  // Cleanup old state visual indicators
  DOM.body.classList.remove(
    'state-sleeping', 
    'state-listening', 
    'state-processing', 
    'state-speaking', 
    'state-error'
  );
  
  // Set new state
  STATE.current = stateName;
  DOM.body.classList.add(`state-${stateName}`);
  
  // Update state text/messages
  let statusText = '';
  switch (stateName) {
    case 'sleeping':
      statusText = 'SAY "START" OR "MAX" TO BEGIN';
      DOM.voiceTriggerBtn.className = 'voice-toggle-btn';
      break;
    case 'listening':
      statusText = 'LISTENING... Speak now';
      DOM.voiceTriggerBtn.className = 'voice-toggle-btn recording-active';
      break;
    case 'processing':
      statusText = 'PROCESSING RESPONSE...';
      DOM.voiceTriggerBtn.className = 'voice-toggle-btn';
      break;
    case 'speaking':
      statusText = 'MAX IS SPEAKING...';
      DOM.voiceTriggerBtn.className = 'voice-toggle-btn speaking-active';
      break;
    case 'error':
      statusText = 'ERROR ENCOUNTERED';
      DOM.voiceTriggerBtn.className = 'voice-toggle-btn';
      break;
  }
  
  DOM.faceStatusText.innerText = statusText;
  DOM.dbStatusInstruction.innerText = statusText;
  
  // Update Waveform Visuals
  updateWaveform(stateName);
}

// Visual feedback on wave bar
function updateWaveform(state) {
  const wave1 = document.getElementById('wave-path-1');
  const wave2 = document.getElementById('wave-path-2');
  if (!wave1 || !wave2) return;
  
  if (state === 'listening') {
    // Large wave movement
    wave1.style.animation = 'scanline-anim 2s linear infinite';
    wave2.style.animation = 'scanline-anim 1.5s linear infinite';
    wave1.setAttribute('d', 'M0,50 Q100,20 200,80 T400,20 T600,80 T800,20 T1000,80 T1200,50');
    wave2.setAttribute('d', 'M0,50 Q120,80 240,20 T480,80 T720,20 T960,80 T1200,50');
  } else if (state === 'speaking') {
    // Dynamic sound wave look
    wave1.style.animation = 'scanline-anim 1s linear infinite';
    wave2.style.animation = 'scanline-anim 0.8s linear infinite';
    wave1.setAttribute('d', 'M0,50 Q75,10 150,90 T300,10 T450,90 T600,10 T750,90 T900,10 T1050,90 T1200,50');
    wave2.setAttribute('d', 'M0,50 Q90,90 180,10 T360,90 T540,10 T720,90 T900,10 T1080,90 T1200,50');
  } else if (state === 'processing') {
    // Slow wave
    wave1.style.animation = 'scanline-anim 4s linear infinite';
    wave2.style.animation = 'scanline-anim 3s linear infinite';
    wave1.setAttribute('d', 'M0,50 Q150,45 300,55 T600,45 T900,55 T1200,50');
    wave2.setAttribute('d', 'M0,50 Q150,55 300,45 T600,55 T900,45 T1200,50');
  } else {
    // Flat line (sleeping or idle)
    wave1.style.animation = 'none';
    wave2.style.animation = 'none';
    wave1.setAttribute('d', 'M0,50 Q150,50 300,50 T600,50 T900,50 T1200,50');
    wave2.setAttribute('d', 'M0,50 Q150,50 300,50 T600,50 T900,50 T1200,50');
  }
}

// ==================== CHAT INTERFACE LOGGING ====================
function appendMessage(sender, text) {
  const isBot = sender === 'bot';
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${isBot ? 'bot-msg' : 'user-msg'}`;
  
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = isBot ? '<i data-lucide="bot"></i>' : '<i data-lucide="user"></i>';
  
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerText = text;
  
  msgDiv.appendChild(avatar);
  msgDiv.appendChild(bubble);
  
  DOM.chatMessages.appendChild(msgDiv);
  lucide.createIcons(); // Instantiates icons inside avatar
  
  // Auto-scroll to bottom
  DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

// ==================== SPEECH RECOGNITION (STT) ====================
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let accumulatedText = '';

// Multilingual Wake Words
const WAKE_WORDS = {
  auto: ['start', 'max', 'தொடங்கு', 'மேக்ஸ்', 'துவங்கு', 'शुरू', 'स्टार्ट', 'मैक्स', 'ప్రారంభించు', 'మాక్స్', 'തുടങ്ങുക', 'മാക്സ്'],
  en: ['start', 'max'],
  ta: ['start', 'max', 'தொடங்கு', 'மேக்ஸ்', 'துவங்கு', 'துவக்கு'],
  hi: ['start', 'max', 'शुरू', 'स्टार्ट', 'मैक्स'],
  te: ['start', 'max', 'ప్రారంభించు', 'స్టార్ట్', 'మాక్స్'],
  ml: ['start', 'max', 'തുടങ്ങുക', 'സ്റ്റാർട്ട്', 'മാക്സ്']
};

// Multilingual Stop Words
const STOP_WORDS = {
  auto: ['stop', 'நிறுத்து', 'रुको', 'आपु', 'നിർത്തുക', 'നിർത്തു', 'പോക്കോ'],
  en: ['stop'],
  ta: ['stop', 'நிறுத்து', 'போது', 'முடி'],
  hi: ['stop', 'रुको', 'बस', 'खत्म'],
  te: ['stop', 'ఆపు', 'చాలు'],
  ml: ['stop', 'നിർത്തുക', 'നിർത്തു']
};

// Main Speech Recognition Setup
function initSpeechEngine() {
  if (!SpeechRecognition) {
    console.error('Speech Recognition not supported in this browser.');
    appendMessage('bot', 'Error: Speech Recognition API is unavailable in this browser.');
    return;
  }
  
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  
  // Set initial language code
  const langKey = STATE.selectedLang;
  const langConf = CONFIG.languages[langKey] || CONFIG.languages.auto;
  rec.lang = langConf.code;
  
  rec.onstart = () => {
    console.log('[Speech Engine]: Microphone active.');
    STATE.recognitionActive = true;
    STATE.recognitionStartTime = Date.now();
  };
  
  rec.onresult = (event) => {
    let interimTranscript = '';
    let localFinal = '';
    
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        localFinal += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }
    
    const text = (localFinal + ' ' + interimTranscript).trim();
    if (!text) return;
    
    const lowerText = text.toLowerCase();
    
    // 1. INSTANT STOP COMMAND (Works even while speaking or processing)
    const stopWordsList = STOP_WORDS[STATE.selectedLang] || STOP_WORDS.auto;
    const matchesStop = stopWordsList.some(word => lowerText.includes(word));
    
    if (matchesStop && (STATE.current === 'listening' || STATE.current === 'speaking' || STATE.current === 'processing')) {
      console.log('[Speech Engine]: Instant stop command triggered!');
      playChime('stop');
      accumulatedText = '';
      if (STATE.activeAudio) {
        try { STATE.activeAudio.pause(); STATE.activeAudio = null; } catch(e){}
      }
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      clearTimeout(STATE.listeningTimeout);
      clearTimeout(STATE.silenceTimeout);
      clearTimeout(STATE.cooldownTimeout);
      
      appendMessage('user', 'stop');
      appendMessage('bot', 'Stopping session. Goodbye.');
      speakText('Stopping session. Goodbye.', 'en');
      transitionTo('sleeping');
      return;
    }
    
    // Discard other inputs if speaking, processing, or in error state
    if (STATE.current === 'processing' || STATE.current === 'speaking' || STATE.current === 'error') {
      return;
    }
    
    // 2. INSTANT WAKE WORD DETECTION (IF SLEEPING)
    if (STATE.current === 'sleeping') {
      const wakeWordsList = WAKE_WORDS[STATE.selectedLang] || WAKE_WORDS.auto;
      const matchesWake = wakeWordsList.some(word => lowerText.includes(word));
      
      if (matchesWake) {
        console.log('[Speech Engine]: Instant wake word triggered!');
        playChime('start');
        accumulatedText = '';
        transitionTo('listening');
        resetListeningTimers();
      }
      return;
    }
    
    // 3. ACTIVE CONVERSATION (IF LISTENING)
    if (STATE.current === 'listening') {
      const fullText = (accumulatedText + ' ' + localFinal + interimTranscript).trim();
      
      // Crowded Room Optimization:
      // Only reset the 2-second silence timer if the transcription text has actually changed!
      const previousUI = DOM.faceStatusText.innerText.replace(/"/g, '').trim();
      if (fullText !== previousUI) {
        resetSilenceTimer();
      }
      
      DOM.faceStatusText.innerText = `"${fullText}"`;
      DOM.dbStatusInstruction.innerText = `"${fullText}"`;
      
      if (localFinal) {
        accumulatedText = (accumulatedText + ' ' + localFinal).trim();
      }
    }
  };
  
  rec.onerror = (err) => {
    console.error('[Speech Engine Error]:', err.error);
    STATE.lastSpeechError = err.error;
    
    // Handle microphone permission denial
    if (err.error === 'not-allowed' || err.error === 'service-not-allowed') {
      STATE.micPermissionDenied = true;
      transitionTo('error');
      DOM.faceStatusText.innerText = 'MIC ACCESS DENIED';
      DOM.dbStatusInstruction.innerText = 'Microphone permission blocked. Please allow mic in settings.';
      appendMessage('bot', 'Microphone permission blocked. Click the microphone button to try again.');
    }
  };
  
  rec.onend = () => {
    STATE.recognitionActive = false;
    console.log('[Speech Engine]: Connection ended.');
    
    // Classify if the connection ended due to a real error (ignore no-speech and aborted manual stops)
    const wasRealError = STATE.lastSpeechError && STATE.lastSpeechError !== 'no-speech' && STATE.lastSpeechError !== 'aborted';
    STATE.lastSpeechError = null; // Reset tracker
    
    // Safeguard: Check for immediate rapid restart loops (less than 1.5 seconds) on real errors
    const duration = Date.now() - (STATE.recognitionStartTime || 0);
    if (wasRealError && duration < 1500) {
      STATE.consecutiveSpeechFailures = (STATE.consecutiveSpeechFailures || 0) + 1;
    } else {
      STATE.consecutiveSpeechFailures = 0;
    }
    
    // Exponential backoff to prevent rapid restarts if the engine is terminating immediately
    if (duration < 2000) {
      STATE.speechRestartDelay = Math.min((STATE.speechRestartDelay || 1000) * 2, 8000);
      console.log(`[Speech Engine]: Rapid end detected. Backing off restart delay to ${STATE.speechRestartDelay}ms.`);
    } else {
      STATE.speechRestartDelay = 1000; // Reset to 1s on normal sessions
    }
    
    if (STATE.consecutiveSpeechFailures >= 4) {
      console.warn('[Speech Engine]: Rapid failure loop detected. Disabling auto-restart.');
      STATE.micPermissionDenied = true; // Block auto-restarts
      appendMessage('bot', 'Microphone connection issue detected. Please tap the screen or mic icon to reset.');
      transitionTo('error');
      DOM.faceStatusText.innerText = 'SPEECH ERROR';
      return;
    }
    
    // Auto-restart if we are in sleeping/listening state, mic is not blocked, and dashboard is not active
    if (!STATE.micPermissionDenied && !STATE.dashboardActive && (STATE.current === 'sleeping' || STATE.current === 'listening')) {
      console.log(`[Speech Engine]: Restarting microphone connection in ${STATE.speechRestartDelay}ms...`);
      setTimeout(() => {
        if (!STATE.micPermissionDenied && !STATE.dashboardActive && (STATE.current === 'sleeping' || STATE.current === 'listening')) {
          try { rec.start(); } catch (e) {}
        }
      }, STATE.speechRestartDelay);
    }
  };
  
  STATE.activeRecognition = rec;
}

// Language changer helper
function changeRecognitionLanguage(langCode) {
  if (STATE.activeRecognition) {
    console.log(`[Speech Engine]: Changing language to ${langCode}`);
    STATE.activeRecognition.lang = langCode;
    
    // Stop the current session. The rec.onend handler will automatically
    // restart the engine with the updated language, preventing overlapping start() race conditions.
    try { 
      STATE.activeRecognition.stop(); 
    } catch(e){}
  }
}

// Active session listening state timers
function resetListeningTimers() {
  clearTimeout(STATE.listeningTimeout);
  clearTimeout(STATE.silenceTimeout);
  
  // 10s maximum listening limit
  STATE.listeningTimeout = setTimeout(() => {
    console.log('[Active Session]: 10s maximum time reached. Triggering processing.');
    triggerProcessing();
  }, 10000);
  
  // 2s silence detection
  resetSilenceTimer();
}

function resetSilenceTimer() {
  clearTimeout(STATE.silenceTimeout);
  
  // 2s silence auto-cut
  STATE.silenceTimeout = setTimeout(() => {
    console.log('[Active Session]: 2 seconds of silence detected. Triggering processing.');
    triggerProcessing();
  }, 2000);
}

// Transitions from listening to processing
function triggerProcessing() {
  clearTimeout(STATE.listeningTimeout);
  clearTimeout(STATE.silenceTimeout);
  
  let userPrompt = accumulatedText.trim();
  accumulatedText = ''; // Clear buffer
  
  // Strip wake words from the beginning of the prompt if present
  const wakeWordsList = WAKE_WORDS[STATE.selectedLang] || WAKE_WORDS.auto;
  for (const word of wakeWordsList) {
    const regex = new RegExp(`^${word}\\b`, 'i');
    if (regex.test(userPrompt)) {
      userPrompt = userPrompt.replace(regex, '').trim();
      break;
    }
  }
  
  if (!userPrompt) {
    console.log('[Active Session]: Empty prompt, resetting timers to continue listening.');
    resetListeningTimers();
    return;
  }
  
  appendMessage('user', userPrompt);
  processPrompt(userPrompt);
}

// ==================== GEMINI API CONNECTION ====================
async function processPrompt(promptText) {
  transitionTo('processing');
  
  // If Force Offline is selected, simulate offline response
  if (!STATE.isOnlineMode) {
    setTimeout(() => {
      const offlineMsg = 'Offline Mode Active. Gemini connection skipped.';
      appendMessage('bot', offlineMsg);
      DOM.latencyVal.innerText = '0 ms (Offline)';
      speakResponseAndContinue(offlineMsg);
    }, 1000);
    return;
  }
  
  const startTime = performance.now();
  let activeModel = STATE.model;
  
  // Use serverless function (/api/chat) if not on localhost or if API key is not configured locally
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const useServerless = !isLocalhost || !STATE.apiKey;
  
  let url = useServerless 
    ? '/api/chat' 
    : `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${STATE.apiKey}`;
  
  // Format history for Gemini call
  // Keep last 6 exchanges to manage context size
  const contextHistory = STATE.chatHistory.slice(-6).map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.text }]
  }));
  
  // Add new prompt
  contextHistory.push({
    role: 'user',
    parts: [{ text: promptText }]
  });
  
  // Formulate instruction based on chosen language
  let systemInstruction = 'You are MAX, a voice assistant. Keep responses extremely brief, conversational, and direct (maximum 1-2 short sentences). ';
  if (STATE.selectedLang !== 'auto') {
    const langConf = CONFIG.languages[STATE.selectedLang];
    systemInstruction += `You must respond ONLY in the ${langConf.name} language. `;
  } else {
    systemInstruction += 'Respond in the exact same language/script that the user spoke (Tamil, English, Hindi, Telugu, or Malayalam). ';
  }
  systemInstruction += 'Avoid markdown bold, formatting lists, bullet points, or complex symbols, as your output is played via Text-to-Speech.';
  
  const getRequestBody = (modelName) => {
    return useServerless ? {
      contents: contextHistory,
      model: modelName,
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      }
    } : {
      contents: contextHistory,
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      }
    };
  };
  
  const controller = new AbortController();
  const networkTimeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout for slow networks
  
  try {
    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(getRequestBody(activeModel)),
      signal: controller.signal
    });
    
    // Check if overloaded (503) or rate-limited (429), and fallback to gemini-3.1-flash-lite
    if ((response.status === 503 || response.status === 429) && activeModel !== 'gemini-3.1-flash-lite') {
      console.warn(`[Gemini API]: Model ${activeModel} failed with HTTP ${response.status}. Falling back to gemini-3.1-flash-lite.`);
      activeModel = 'gemini-3.1-flash-lite';
      
      url = useServerless 
        ? '/api/chat' 
        : `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${STATE.apiKey}`;
      
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(getRequestBody(activeModel)),
        signal: controller.signal
      });
    }
    
    clearTimeout(networkTimeoutId);
    
    const latency = Math.round(performance.now() - startTime);
    DOM.latencyVal.innerText = `${latency} ms`;
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || `HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const botResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!botResponse) {
      throw new Error('Empty response received from Gemini.');
    }
    
    console.log(`[Gemini Response]: "${botResponse}" (latency: ${latency}ms)`);
    
    // Save to conversation logs
    STATE.chatHistory.push({ role: 'user', text: promptText });
    STATE.chatHistory.push({ role: 'bot', text: botResponse });
    
    appendMessage('bot', botResponse);
    speakResponseAndContinue(botResponse);
    
  } catch (error) {
    clearTimeout(networkTimeoutId);
    console.error('[Gemini API Call Failed]:', error);
    playChime('error');
    
    let errMsg = `Error: Could not connect to API. ${error.message}`;
    if (error.name === 'AbortError') {
      errMsg = 'Error: Connection timeout. Network is too slow.';
      // Automatically retry once with the light model if not already using it
      if (activeModel !== 'gemini-3.1-flash-lite') {
        console.log('[Network Timeout]: Retrying immediately with gemini-3.1-flash-lite.');
        STATE.model = 'gemini-3.1-flash-lite';
        processPrompt(promptText);
        return;
      }
    }
    
    appendMessage('bot', errMsg);
    
    // Transition to error, and wait 3s before resetting
    transitionTo('error');
    setTimeout(() => {
      transitionTo('sleeping');
      if (!STATE.recognitionActive) {
        try { STATE.activeRecognition.start(); } catch(e){}
      }
    }, 3000);
  }
}

// ==================== SPEECH SYNTHESIS (TTS) ====================
function speakResponseAndContinue(text) {
  transitionTo('speaking');
  
  // Detect language spoken to select appropriate synthesizer voice
  // We match character blocks for Hindi/Tamil/Telugu/Malayalam, otherwise default to English
  let detectedLang = 'en';
  if (/[\u0B80-\u0BFF]/.test(text)) detectedLang = 'ta'; // Tamil
  else if (/[\u0900-\u097F]/.test(text)) detectedLang = 'hi'; // Hindi
  else if (/[\u0C00-\u0C7F]/.test(text)) detectedLang = 'te'; // Telugu
  else if (/[\u0D00-\u0D7F]/.test(text)) detectedLang = 'ml'; // Malayalam
  
  speakText(text, detectedLang, () => {
    console.log('[Speaking Finished]: Transitioning back to active listening.');
    transitionTo('listening');
    resetListeningTimers();
  });
}

function speakViaTranslateAPI(text, langCode, callback) {
  // Cancel previous audio if any
  if (STATE.activeAudio) {
    try {
      STATE.activeAudio.pause();
      STATE.activeAudio = null;
    } catch(e){}
  }
  
  // Use Vercel serverless proxy '/api/tts' when hosted to bypass CORS/Referer blocks.
  // Fall back to direct Google URL on localhost.
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const url = isLocalhost 
    ? `https://translate.google.com/translate_tts?ie=UTF-8&tl=${langCode}&client=tw-ob&q=${encodeURIComponent(text)}`
    : `/api/tts?lang=${langCode}&text=${encodeURIComponent(text)}`;
    
  const audio = new Audio(url);
  audio.playbackRate = STATE.voiceSpeed;
  
  STATE.activeAudio = audio;
  STATE.isSpeechActive = true;
  
  audio.addEventListener('play', () => {
    console.log(`[TTS API]: Playing speech in ${langCode}`);
  });
  
  audio.addEventListener('ended', () => {
    STATE.isSpeechActive = false;
    STATE.activeAudio = null;
    if (callback) callback();
  });
  
  audio.addEventListener('error', (e) => {
    console.error('[TTS API Error]: Failed to play audio via Translate TTS API.', e);
    STATE.isSpeechActive = false;
    STATE.activeAudio = null;
    // Fall back to native TTS
    speakViaNativeSpeech(text, langCode, callback);
  });
  
  audio.play().catch(err => {
    console.error('[TTS API Play Blocked]:', err);
    STATE.isSpeechActive = false;
    STATE.activeAudio = null;
    // Fall back to native TTS
    speakViaNativeSpeech(text, langCode, callback);
  });
}

function speakViaNativeSpeech(text, langCode, callback) {
  if (!('speechSynthesis' in window)) {
    if (callback) callback();
    return;
  }
  
  window.speechSynthesis.cancel();
  
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = STATE.voiceSpeed;
  utterance.pitch = 1.0;
  utterance.lang = langCode;
  
  const voices = window.speechSynthesis.getVoices();
  let matchedVoice = voices.find(voice => voice.lang.toLowerCase() === langCode.toLowerCase());
  if (!matchedVoice) {
    const prefix = langCode.split('-')[0];
    matchedVoice = voices.find(voice => voice.lang.toLowerCase().startsWith(prefix));
  }
  
  if (matchedVoice) {
    utterance.voice = matchedVoice;
  }
  
  utterance.onstart = () => {
    STATE.isSpeechActive = true;
  };
  
  utterance.onend = () => {
    STATE.isSpeechActive = false;
    if (callback) callback();
  };
  
  utterance.onerror = (e) => {
    console.error('[Native TTS Error]:', e);
    STATE.isSpeechActive = false;
    if (callback) callback();
  };
  
  window.speechSynthesis.speak(utterance);
}

function speakText(text, langKey, callback) {
  const langConf = CONFIG.languages[langKey] || CONFIG.languages.auto;
  const targetCode = langConf.code;
  const langPrefix = targetCode.split('-')[0];
  
  // Cancel native speech if running
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  
  // Cancel active HTML5 audio if running
  if (STATE.activeAudio) {
    try {
      STATE.activeAudio.pause();
      STATE.activeAudio = null;
    } catch(e){}
  }
  
  if (langPrefix === 'en') {
    speakViaNativeSpeech(text, targetCode, callback);
  } else {
    speakViaTranslateAPI(text, langPrefix, callback);
  }
}

// Pre-load voices on browser compatibility triggers
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    console.log('[TTS Voices loaded]: Total voices available:', window.speechSynthesis.getVoices().length);
  };
}

// ==================== MANUAL TRIGGER EVENTS ====================

// Mic Button toggles listening
function handleVoiceToggleBtn() {
  STATE.micPermissionDenied = false; // Reset permission state so user click can retry
  
  if (STATE.current === 'sleeping' || STATE.current === 'error') {
    // Force start active session
    playChime('start');
    accumulatedText = '';
    transitionTo('listening');
    resetListeningTimers();
    if (!STATE.recognitionActive) {
      try { STATE.activeRecognition.start(); } catch (e) {}
    }
  } else {
    // Explicit cancel or stop
    console.log('[Voice Button]: Manual Stop session.');
    playChime('stop');
    
    // Stop recognition
    if (STATE.activeRecognition) {
      try { STATE.activeRecognition.stop(); } catch(e) {}
    }
    if (STATE.activeAudio) {
      try { STATE.activeAudio.pause(); STATE.activeAudio = null; } catch(e){}
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    
    clearTimeout(STATE.listeningTimeout);
    clearTimeout(STATE.silenceTimeout);
    clearTimeout(STATE.cooldownTimeout);
    
    transitionTo('sleeping');
    if (!STATE.recognitionActive) {
      try { STATE.activeRecognition.start(); } catch (e) {}
    }
  }
}

// Text query submission
function handleManualSend() {
  const prompt = DOM.manualTextInput.value.trim();
  if (!prompt) return;
  
  DOM.manualTextInput.value = '';
  appendMessage('user', prompt);
  
  // Stop active listening/speech if running
  if (STATE.activeRecognition) {
    try { STATE.activeRecognition.stop(); } catch(e) {}
  }
  if (STATE.activeAudio) {
    try { STATE.activeAudio.pause(); STATE.activeAudio = null; } catch(e){}
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  
  clearTimeout(STATE.listeningTimeout);
  clearTimeout(STATE.silenceTimeout);
  clearTimeout(STATE.cooldownTimeout);
  
  processPrompt(prompt);
}

function enterFullscreen() {
  const docEl = document.documentElement;
  try {
    if (docEl.requestFullscreen) docEl.requestFullscreen();
    else if (docEl.webkitRequestFullscreen) docEl.webkitRequestFullscreen();
    else if (docEl.msRequestFullscreen) docEl.msRequestFullscreen();
  } catch (e) {
    console.warn('[Fullscreen]: Browser blocked fullscreen request.', e);
  }
}

// ==================== UI BINDINGS & TOGGLES ====================

// Setup page event listeners
function bindUIEvents() {
  // Toggle Dashboard overlay via corner click
  DOM.hiddenTrigger.addEventListener('click', () => {
    STATE.dashboardActive = true;
    DOM.faceContainer.classList.add('hidden');
    DOM.dashboardContainer.classList.remove('hidden');
    if (STATE.activeRecognition) {
      try { STATE.activeRecognition.stop(); } catch(e){}
    }
  });
  
  // Back to Face Button (Smiley)
  DOM.dbBackBtn.addEventListener('click', () => {
    STATE.dashboardActive = false;
    DOM.dashboardContainer.classList.add('hidden');
    DOM.faceContainer.classList.remove('hidden');
    enterFullscreen();
    if (STATE.activeRecognition && !STATE.micPermissionDenied) {
      try { STATE.activeRecognition.start(); } catch(e){}
    }
  });
  
  // Voice Toggle Button
  DOM.voiceTriggerBtn.addEventListener('click', handleVoiceToggleBtn);
  
  // Manual Send text field bindings
  DOM.manualSendBtn.addEventListener('click', handleManualSend);
  DOM.manualTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleManualSend();
  });
  
  // Mode selectors (Online/Offline)
  DOM.modeGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.control-btn');
    if (!btn) return;
    
    DOM.modeGroup.querySelectorAll('.control-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const mode = btn.dataset.mode;
    const statusDot = document.querySelector('.status-dot');
    const badge = document.querySelector('.status-badge');
    
    if (mode === 'offline') {
      STATE.isOnlineMode = false;
      badge.innerHTML = '<span class="status-dot" style="background-color: var(--red-color); box-shadow: 0 0 8px var(--red-color); animation: none"></span> Offline Mode';
      badge.style.color = 'var(--red-color)';
      badge.style.borderColor = 'rgba(255, 23, 68, 0.3)';
      badge.style.backgroundColor = 'rgba(255, 23, 68, 0.08)';
    } else {
      // Auto or Force Online both enable online requests
      STATE.isOnlineMode = true;
      badge.innerHTML = '<span class="status-dot"></span> Online Mode';
      badge.style.color = 'var(--green-color)';
      badge.style.borderColor = 'rgba(0, 230, 118, 0.3)';
      badge.style.backgroundColor = 'rgba(0, 230, 118, 0.08)';
    }
  });
  
  // Language Selector Group
  DOM.langGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.control-btn');
    if (!btn) return;
    
    DOM.langGroup.querySelectorAll('.control-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    STATE.selectedLang = btn.dataset.lang;
    const langInfo = CONFIG.languages[STATE.selectedLang] || CONFIG.languages.auto;
    DOM.langStatus.innerText = `${langInfo.name} (Code: ${langInfo.code})`;
    
    console.log(`[Language Changed]: Selected ${STATE.selectedLang}`);
    
    // Update recognition language immediately
    changeRecognitionLanguage(langInfo.code);
  });
  
  // Settings Panel Toggles
  DOM.settingsToggle.addEventListener('click', () => {
    DOM.settingsApiKey.value = STATE.apiKey;
    DOM.settingsModel.value = STATE.model;
    DOM.settingsVoiceSpeed.value = STATE.voiceSpeed;
    DOM.speedVal.innerText = `${STATE.voiceSpeed.toFixed(1)}x`;
    
    const langInfo = CONFIG.languages[STATE.selectedLang] || CONFIG.languages.auto;
    DOM.langStatus.innerText = `${langInfo.name} (Code: ${langInfo.code})`;
    
    DOM.settingsModal.classList.remove('hidden');
  });
  
  DOM.closeSettingsBtn.addEventListener('click', () => {
    DOM.settingsModal.classList.add('hidden');
  });
  
  // Save Settings Changes
  DOM.saveSettingsBtn.addEventListener('click', () => {
    const key = DOM.settingsApiKey.value.trim();
    const model = DOM.settingsModel.value;
    const speed = parseFloat(DOM.settingsVoiceSpeed.value);
    
    if (key) {
      STATE.apiKey = key;
      localStorage.setItem('max_api_key', key);
    }
    
    STATE.model = model;
    localStorage.setItem('max_model', model);
    
    STATE.voiceSpeed = speed;
    localStorage.setItem('max_voice_speed', speed.toString());
    
    console.log('[Settings Saved]: Configuration updated.');
    DOM.settingsModal.classList.add('hidden');
  });
  
  DOM.settingsVoiceSpeed.addEventListener('input', (e) => {
    DOM.speedVal.innerText = `${parseFloat(e.target.value).toFixed(1)}x`;
  });
  
  // Close modal when clicking outside contents
  window.addEventListener('click', (e) => {
    if (e.target === DOM.settingsModal) {
      DOM.settingsModal.classList.add('hidden');
    }
  });
}

// ==================== APP INITIALIZATION ====================
function init() {
  // Bind UI interactions
  bindUIEvents();
  
  // Instantiate icons
  lucide.createIcons();
  
  // Set initial state
  transitionTo('sleeping');
  
  // Set default api key input value for reference
  DOM.settingsApiKey.value = STATE.apiKey;
  
  // Initialize speech engine and start listening
  initSpeechEngine();
  try {
    STATE.activeRecognition.start();
  } catch (e) {
    console.warn('[Speech Engine start failed on load]:', e);
  }
  
  // Unblock speech synthesis and audio context on user click
  window.addEventListener('click', () => {
    // Reset micPermissionDenied so clicking works as a retry trigger
    STATE.micPermissionDenied = false;
    
    if (window.speechSynthesis && window.speechSynthesis.pending) {
      window.speechSynthesis.resume();
    }
    
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
    } catch (e) {}
    
    // Automatically enter fullscreen on first tap if in face screen
    if (DOM.dashboardContainer.classList.contains('hidden')) {
      enterFullscreen();
    }
  });
  
  console.log('[MAX Assistant]: Initialized successfully.');
}

// Run app on content load
window.addEventListener('DOMContentLoaded', init);

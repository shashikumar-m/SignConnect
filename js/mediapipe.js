/**
 * SignConnect — GestureEngine v3 (LSTM on Holistic landmarks)
 * mediapipe.js
 *
 * Two modes:
 *   LSTM mode  — if model.json has modelType:"lstm", uses rolling frame window
 *   Static mode — falls back to previous MLP on single-frame features
 */

const GestureEngine = (() => {
  'use strict';

  // ── Model state ────────────────────────────────────────────
  let modelMeta   = null;   // parsed model.json
  let modelLabels = [];
  let modelReady  = false;
  let isLSTM      = false;

  // LSTM weights (loaded manually from binary)
  let Wx, Wh, b_, Wd, bd, Wo, bo;
  let H = 128;

  // MLP weights (fallback)
  let tfModel = null;

  // ── Temporal buffer (LSTM needs sequence of frames) ────────
  let SEQ_LEN   = 30;
  let FRAME_SIZE = 225;
  const frameBuffer = [];  // rolling window

  // ── Stability / cooldown ───────────────────────────────────
  const HOLD_FRAMES   = 6;
  const EMIT_COOLDOWN = 1500;
  let holdName = null, holdCount = 0, lastEmitted = null, lastEmitTs = 0;

  // ── Fingerpose fallback ────────────────────────────────────
  let fpGE = null, fpReady = false;

  // ── 1. Load model ──────────────────────────────────────────
  async function loadModel() {
    try {
      const resp = await fetch('/js/gesture_model/model.json');
      if (!resp.ok) throw new Error('model.json not found');
      modelMeta   = await resp.json();
      modelLabels = modelMeta.labels || [];
      isLSTM      = modelMeta.modelType === 'lstm';
      SEQ_LEN     = modelMeta.seqLen    || 30;
      FRAME_SIZE  = modelMeta.frameSize || 225;
      H           = modelMeta.hiddenUnits || 128;

      if (isLSTM) {
        await loadLSTMWeights(modelMeta);
        modelReady = true;
        console.log(`[GestureEngine] LSTM model ready — ${modelLabels.length} signs, seq=${SEQ_LEN}`);
      } else {
        // MLP mode — load via TF.js
        await loadTFJS();
      }
    } catch (e) {
      console.warn('[GestureEngine] Model load failed:', e.message);
      initFingerpose();
    }
  }

  async function loadLSTMWeights(meta) {
    const manifest = meta.weightsManifest[0];
    const url      = '/js/gesture_model/' + manifest.paths[0];
    const resp     = await fetch(url);
    const buf      = await resp.arrayBuffer();
    const floats   = new Float32Array(buf);

    // Parse weight specs
    const specs = manifest.weights;
    function getWeight(name) {
      const s = specs.find(w => w.name === name);
      if (!s) throw new Error('weight not found: ' + name);
      const arr = floats.slice(s.byteOffset/4, (s.byteOffset+s.byteLength)/4);
      return { data: arr, shape: s.shape };
    }

    function mat(name) {
      const w = getWeight(name);
      return { data: w.data, rows: w.shape[0], cols: w.shape[1] };
    }
    function vec(name) {
      const w = getWeight(name);
      return w.data;
    }

    Wx  = mat('lstm/Wx');
    Wh  = mat('lstm/Wh');
    b_  = vec('lstm/b');
    Wd  = mat('dense/W');
    bd  = vec('dense/b');
    Wo  = mat('out/W');
    bo  = vec('out/b');
  }

  async function loadTFJS() {
    if (!window.tf) {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.15.0/dist/tf.min.js';
      await new Promise((res, rej) => { s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    }
    tfModel    = await window.tf.loadLayersModel('/js/gesture_model/model.json');
    modelReady = true;
    console.log(`[GestureEngine] MLP model ready — ${modelLabels.length} signs`);
  }

  // ── 2. Fingerpose fallback ─────────────────────────────────
  function initFingerpose() {
    if (!window.fp) return;
    const { GestureDescription, Finger, FingerCurl, FingerDirection, GestureEstimator } = window.fp;
    const gestures = [];
    const add = (name, curls, thumbDir) => {
      const g = new GestureDescription(name);
      const F = [Finger.Thumb,Finger.Index,Finger.Middle,Finger.Ring,Finger.Pinky];
      const C = { 0: FingerCurl.FullCurl, 0.5: FingerCurl.HalfCurl, 1: FingerCurl.NoCurl };
      curls.forEach((c,i) => { if(c!==-1) g.addCurl(F[i], C[c]||FingerCurl.NoCurl, 1.0); });
      if (thumbDir===1)  g.addDirection(Finger.Thumb, FingerDirection.VerticalUp, 1.0);
      if (thumbDir===-1) g.addDirection(Finger.Thumb, FingerDirection.VerticalDown, 1.0);
      gestures.push(g);
    };
    add('Hello',      [1,1,1,1,1],   0);
    add('I Love You', [1,1,0,0,1],   1);
    add('Yes',        [0,0,0,0,0],   0);
    add('No',         [0,1,0,0,0],   0);
    add('Stop',       [0,1,1,1,1],   0);
    add('Good',       [1,0,0,0,0],   1);
    add('Bad',        [1,0,0,0,0],  -1);
    add('Peace',      [0,1,1,0,0],   0);
    add('Thank You',  [0,1,1,1,1],   0);
    add('Help',       [1,0,0,0,0],   1);
    fpGE    = new GestureEstimator(gestures);
    fpReady = true;
    console.log('[GestureEngine] Fingerpose fallback ready');
  }

  loadModel();
  setTimeout(() => { if (!modelReady) initFingerpose(); }, 4000);

  // ── 3. processFrame — main entry point ────────────────────
  // landmarks can be:
  //   - array of 21 {x,y,z} objects  (hand only, from MediaPipe Hands)
  //   - object { pose, leftHand, rightHand } (from Holistic)

  function processFrame(landmarks) {
    let raw = null;

    if (isLSTM && modelReady) {
      // Build feature vector from holistic or hand-only
      const feat = buildFeatureVector(landmarks);
      raw = predictWithLSTM(feat);
    } else if (modelReady && tfModel) {
      raw = predictWithMLP(landmarks);
    } else if (fpReady && fpGE) {
      const handLm = Array.isArray(landmarks) ? landmarks : landmarks.rightHand || landmarks.leftHand;
      if (!handLm) return { name: '...', confidence: 0, emit: false };
      raw = predictWithFingerpose(handLm);
    }

    if (!raw) return { name: '...', confidence: 0, emit: false };

    // Stability
    if (raw.name === holdName) holdCount++;
    else { holdName = raw.name; holdCount = 1; }

    const now     = Date.now();
    const canEmit = holdCount >= HOLD_FRAMES &&
      (raw.name !== lastEmitted || now - lastEmitTs > EMIT_COOLDOWN) &&
      raw.name !== '...';

    if (canEmit) { lastEmitted = raw.name; lastEmitTs = now; return { ...raw, emit: true }; }
    return { ...raw, emit: false };
  }

  // ── Build 225-feature vector ───────────────────────────────
  function buildFeatureVector(landmarks) {
    const feat = new Float32Array(225);
    let i = 0;

    if (landmarks && !Array.isArray(landmarks)) {
      // Holistic: { pose, leftHand, rightHand }
      const fillLandmarks = (lms, count) => {
        if (lms) {
          for (let j = 0; j < count && j < lms.length; j++) {
            feat[i++] = lms[j].x || 0;
            feat[i++] = lms[j].y || 0;
            feat[i++] = lms[j].z || 0;
          }
        } else { i += count * 3; }
      };
      fillLandmarks(landmarks.pose,      33);
      fillLandmarks(landmarks.leftHand,  21);
      fillLandmarks(landmarks.rightHand, 21);
    } else if (Array.isArray(landmarks)) {
      // Hand-only (21 landmarks) — pad pose with zeros
      i += 99; // skip pose
      for (const lm of landmarks) {
        feat[i++] = lm.x; feat[i++] = lm.y; feat[i++] = lm.z || 0;
      }
      // right hand same
      for (const lm of landmarks) {
        feat[i++] = lm.x; feat[i++] = lm.y; feat[i++] = lm.z || 0;
      }
    }

    return feat;
  }

  // ── LSTM inference ─────────────────────────────────────────
  function predictWithLSTM(feat) {
    // Add to rolling buffer
    frameBuffer.push(feat);
    if (frameBuffer.length > SEQ_LEN) frameBuffer.shift();
    if (frameBuffer.length < SEQ_LEN) return { name: '...', confidence: 0 };

    try {
      // Run LSTM forward pass (single sample)
      let h = new Float32Array(H);
      let c = new Float32Array(H);

      for (let t = 0; t < SEQ_LEN; t++) {
        const x = frameBuffer[t];
        // gates = x @ Wx + h @ Wh + b_  shape: (4H,)
        const gates = new Float32Array(4 * H);
        // x @ Wx
        for (let j = 0; j < 4*H; j++) {
          let s = b_[j];
          for (let k = 0; k < FRAME_SIZE && k < Wx.rows; k++) s += x[k] * Wx.data[k*Wx.cols+j];
          for (let k = 0; k < H; k++) s += h[k] * Wh.data[k*Wh.cols+j];
          gates[j] = s;
        }
        const ig = gates.slice(0,   H).map(sigmoid1);
        const fg = gates.slice(H,   2*H).map(sigmoid1);
        const gg = gates.slice(2*H, 3*H).map(tanh1);
        const og = gates.slice(3*H, 4*H).map(sigmoid1);
        const newC = new Float32Array(H);
        const newH = new Float32Array(H);
        for (let j = 0; j < H; j++) {
          newC[j] = fg[j]*c[j] + ig[j]*gg[j];
          newH[j] = og[j]*tanh1(newC[j]);
        }
        h = newH; c = newC;
      }

      // Dense: relu(h @ Wd + bd)
      const d = new Float32Array(Wd.cols);
      for (let j = 0; j < Wd.cols; j++) {
        let s = bd[j];
        for (let k = 0; k < H; k++) s += h[k] * Wd.data[k*Wd.cols+j];
        d[j] = Math.max(0, s);
      }

      // Output: softmax(d @ Wo + bo)
      const logits = new Float32Array(Wo.cols);
      for (let j = 0; j < Wo.cols; j++) {
        let s = bo[j];
        for (let k = 0; k < Wd.cols; k++) s += d[k] * Wo.data[k*Wo.cols+j];
        logits[j] = s;
      }
      const probs = softmax1(logits);
      const best  = Array.from(probs).indexOf(Math.max(...probs));
      const conf  = probs[best];

      if (conf < 0.5) return { name: '...', confidence: conf };
      return { name: modelLabels[best], confidence: conf };

    } catch (e) {
      console.warn('[LSTM] predict error:', e.message);
      return null;
    }
  }

  // Math helpers
  const sigmoid1 = x => 1/(1+Math.exp(-Math.max(-15,Math.min(15,x))));
  const tanh1    = x => Math.tanh(Math.max(-15,Math.min(15,x)));
  function softmax1(arr) {
    const max = Math.max(...arr);
    const e   = arr.map(x => Math.exp(x - max));
    const sum = e.reduce((a,b) => a+b, 0);
    return e.map(x => x/sum);
  }

  // ── MLP inference (94-feature static model) ───────────────
  function predictWithMLP(landmarks) {
    if (!tfModel || !window.tf) return null;
    try {
      const handLm = Array.isArray(landmarks) ? landmarks
        : (landmarks.rightHand || landmarks.leftHand);
      if (!handLm || handLm.length < 21) return { name: '...', confidence: 0 };

      const pts   = handLm.map(lm => [lm.x, lm.y, lm.z||0]);
      const wrist = pts[0];
      const psize = Math.hypot(pts[9][0]-wrist[0],pts[9][1]-wrist[1],pts[9][2]-wrist[2])+1e-6;
      const norm  = pts.map(p => [(p[0]-wrist[0])/psize,(p[1]-wrist[1])/psize,(p[2]-wrist[2])/psize]);
      const feat1 = norm.flat();
      const tips  = [4,8,12,16,20];
      const feat2 = tips.map(t=>Math.hypot(pts[t][0]-wrist[0],pts[t][1]-wrist[1],pts[t][2]-wrist[2])/psize);
      const feat3 = [[8,7],[12,11],[16,15],[20,19],[4,3]].map(([a,b])=>(pts[a][1]-pts[b][1])/psize);
      const feat4 = tips.map((t,i)=>(pts[t][1]-[5,9,13,17,2].map(m=>pts[m])[i][1])/psize);
      const feat5 = [(pts[4][0]-pts[5][0])/psize];
      const chains=[[0,1,2,3,4],[0,5,6,7,8],[0,9,10,11,12],[0,13,14,15,16],[0,17,18,19,20]];
      const feat6=[];
      for(const ch of chains) for(let i=0;i<ch.length-2;i++){
        const a=pts[ch[i]],b=pts[ch[i+1]],c=pts[ch[i+2]];
        const ab=[a[0]-b[0],a[1]-b[1],a[2]-b[2]],cb=[c[0]-b[0],c[1]-b[1],c[2]-b[2]];
        const dot=ab[0]*cb[0]+ab[1]*cb[1]+ab[2]*cb[2];
        const mag=Math.hypot(...ab)*Math.hypot(...cb)+1e-9;
        feat6.push(Math.max(-1,Math.min(1,dot/mag)));
      }
      const input=[...feat1,...feat2,...feat3,...feat4,...feat5,...feat6];
      const tensor=window.tf.tensor2d([input],[1,input.length]);
      const probs=tfModel.predict(tensor).dataSync(); tensor.dispose();
      const best=Array.from(probs).indexOf(Math.max(...probs));
      if(probs[best]<0.55) return {name:'...',confidence:probs[best]};
      return {name:modelLabels[best],confidence:probs[best]};
    } catch { return null; }
  }

  // ── Fingerpose inference ───────────────────────────────────
  function predictWithFingerpose(landmarks) {
    try {
      const kp = landmarks.map(lm=>[lm.x*300,lm.y*300,(lm.z||0)*300]);
      const est=fpGE.estimate(kp,7.5);
      if(!est.gestures.length) return {name:'...',confidence:0};
      const best=est.gestures.reduce((a,b)=>a.score>b.score?a:b);
      return {name:best.name,confidence:Math.min(1,best.score/10)};
    } catch { return null; }
  }

  // ── Drawing helpers ────────────────────────────────────────
  const CONNECTIONS=[
    [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],[0,17]
  ];
  const COLORS=['#ff6b6b','#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#c77dff'];
  const colorOf=i=>i===0?0:i<=4?1:i<=8?2:i<=12?3:i<=16?4:5;

  function drawHandOnCanvas(ctx, landmarks, W, H_, mirrored=true) {
    // landmarks can be array of {x,y,z} or holistic object
    const lms = Array.isArray(landmarks) ? landmarks
      : (landmarks.rightHand || landmarks.leftHand || []);
    if (!lms.length) return;
    const pts = lms.map(lm=>({
      x: mirrored?(1-lm.x)*W:lm.x*W,
      y: lm.y*H_
    }));
    ctx.lineWidth=2; ctx.lineCap='round';
    for(const [a,b] of CONNECTIONS){
      ctx.strokeStyle='rgba(255,255,255,0.4)';
      ctx.beginPath(); ctx.moveTo(pts[a].x,pts[a].y); ctx.lineTo(pts[b].x,pts[b].y); ctx.stroke();
    }
    for(let i=0;i<pts.length;i++){
      ctx.beginPath(); ctx.arc(pts[i].x,pts[i].y,i===0?5:4,0,Math.PI*2);
      ctx.fillStyle=COLORS[colorOf(i)]; ctx.fill();
      ctx.strokeStyle='rgba(0,0,0,0.4)'; ctx.lineWidth=1; ctx.stroke();
    }
  }

  function clearCanvas(ctx,w,h){ ctx.clearRect(0,0,w,h); }
  function clearFrameBuffer() { frameBuffer.length = 0; }

  return {
    processFrame, drawHandOnCanvas, clearCanvas, clearFrameBuffer,
    isModelReady: ()=>modelReady, isLSTM: ()=>isLSTM,
    buildFeatureVector
  };
})();

window.GestureEngine = GestureEngine;

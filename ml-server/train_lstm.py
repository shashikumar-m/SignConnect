"""
train_lstm.py
Trains an LSTM on your recorded sign sequences from collect.html.
Exports a TF.js-compatible model to js/gesture_model/

Usage:
  python ml-server/train_lstm.py                         # uses my_signs.json
  python ml-server/train_lstm.py path/to/my_signs.json   # custom path

Output:
  js/gesture_model/model.json
  js/gesture_model/group1-shard1of1.bin
"""

import os, sys, json, struct
import numpy as np
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics import accuracy_score, classification_report

# ── Load data ──────────────────────────────────────────────────────────────────
data_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("my_signs.json")
if not data_path.exists():
    # also look in project root
    alt = Path(__file__).parent.parent / "my_signs.json"
    if alt.exists(): data_path = alt
    else:
        print(f"ERROR: {data_path} not found.")
        print("  Export from the collector at http://localhost:5001/collect.html")
        sys.exit(1)

print(f"Loading {data_path}...")
with open(data_path) as f:
    raw = json.load(f)

FRAME_SIZE = raw.get("frameSize", 225)
recordings = raw["recordings"]   # { label: [[frame,...], ...] }

print(f"  Frame size: {FRAME_SIZE}")
for label, seqs in sorted(recordings.items()):
    print(f"  {label}: {len(seqs)} recordings x {len(seqs[0])} frames")

# ── Pad / truncate all sequences to fixed length ───────────────────────────────
SEQ_LEN = 30   # fixed window length

def pad_sequence(seq, length, feat_size):
    """Pad with zeros or truncate to fixed length."""
    arr = np.zeros((length, feat_size), dtype=np.float32)
    n   = min(len(seq), length)
    for i in range(n):
        arr[i] = seq[i][:feat_size]
    return arr

X_list, y_list = [], []
for label, seqs in recordings.items():
    for seq in seqs:
        x = pad_sequence(seq, SEQ_LEN, FRAME_SIZE)
        X_list.append(x)
        y_list.append(label)

X  = np.array(X_list, dtype=np.float32)   # (N, SEQ_LEN, FRAME_SIZE)
le = LabelEncoder()
y  = le.fit_transform(y_list)
LABELS = le.classes_.tolist()
N = len(LABELS)
print(f"\nDataset: {X.shape}  {N} classes: {LABELS}")

if len(X) < 10:
    print("ERROR: Not enough data. Record at least 10 samples per sign.")
    sys.exit(1)

X_tr, X_te, y_tr, y_te = train_test_split(
    X, y, test_size=0.15, stratify=y, random_state=42
)
print(f"Train: {len(X_tr)}  Test: {len(X_te)}")

# ── LSTM in NumPy (no TF dependency) ──────────────────────────────────────────
# Simple LSTM cell from scratch, then dense output

np.random.seed(42)

H = 128   # hidden units

def sigmoid(x):  return 1 / (1 + np.exp(-np.clip(x, -15, 15)))
def tanh(x):     return np.tanh(np.clip(x, -15, 15))
def softmax(x):
    e = np.exp(x - x.max(1, keepdims=True))
    return e / e.sum(1, keepdims=True)

def he(a, b): return (np.random.randn(a, b) * np.sqrt(2/a)).astype(np.float32)
def ortho(n):
    Q, _ = np.linalg.qr(np.random.randn(n, n))
    return Q.astype(np.float32)

# LSTM weights (input gate, forget gate, cell gate, output gate)
# Combined matrices for efficiency: W_i [4H x D], W_h [4H x H]
D = FRAME_SIZE
Wx  = he(D, 4*H)       # input -> gates
Wh  = ortho(H)[:, :4*H] if 4*H <= H else he(H, 4*H)  # recurrent
b_  = np.zeros((1, 4*H), dtype=np.float32)

# Dense output
Wd = he(H, 64);  bd = np.zeros((1,64), np.float32)
Wo = he(64, N);  bo = np.zeros((1,N),  np.float32)

def lstm_forward_batch(Xb):
    """Forward pass through LSTM for a batch.
    Xb: (batch, seq_len, D)
    Returns: (batch, H) — last hidden state
    """
    B = Xb.shape[0]
    h = np.zeros((B, H), dtype=np.float32)
    c = np.zeros((B, H), dtype=np.float32)

    for t in range(SEQ_LEN):
        x_t = Xb[:, t, :]                    # (B, D)
        gates = x_t @ Wx + h @ Wh + b_       # (B, 4H)
        i_g = sigmoid(gates[:, :H])
        f_g = sigmoid(gates[:, H:2*H])
        g_g = tanh(   gates[:, 2*H:3*H])
        o_g = sigmoid(gates[:, 3*H:])
        c   = f_g * c + i_g * g_g
        h   = o_g * tanh(c)

    return h   # (B, H)

def forward(Xb):
    h = lstm_forward_batch(Xb)
    d = np.maximum(0, h @ Wd + bd)   # relu dense
    p = softmax(d @ Wo + bo)
    return h, d, p

def xloss(p, y): return -np.log(p[np.arange(len(y)), y] + 1e-9).mean()

# ── Training ───────────────────────────────────────────────────────────────────
EPOCHS = 100
LR     = 0.005
BS     = 32
DECAY  = 0.98
lr     = LR
n      = len(X_tr)

best_acc = 0
best_w   = None

print(f"\nTraining LSTM ({EPOCHS} epochs, H={H}, seq={SEQ_LEN}, D={FRAME_SIZE})...")
print("Note: NumPy LSTM is slow — expect ~2-5 min per epoch for large datasets\n")

for ep in range(EPOCHS):
    ix = np.random.permutation(n)
    for i in range(0, n, BS):
        Xb = X_tr[ix[i:i+BS]]
        yb = y_tr[ix[i:i+BS]]
        nb = len(yb)

        # Forward
        B = nb
        h_all = np.zeros((B, SEQ_LEN, H), dtype=np.float32)
        c_all = np.zeros((B, SEQ_LEN, H), dtype=np.float32)
        g_all = np.zeros((B, SEQ_LEN, 4*H), dtype=np.float32)
        h_t   = np.zeros((B, H), np.float32)
        c_t   = np.zeros((B, H), np.float32)

        for t in range(SEQ_LEN):
            x_t = Xb[:, t, :]
            g   = x_t @ Wx + h_t @ Wh + b_
            g_all[:, t] = g
            ig = sigmoid(g[:, :H]);    fg = sigmoid(g[:, H:2*H])
            gg = tanh(g[:, 2*H:3*H]); og = sigmoid(g[:, 3*H:])
            c_t = fg * c_t + ig * gg
            h_t = og * tanh(c_t)
            h_all[:, t] = h_t
            c_all[:, t] = c_t

        h_last = h_all[:, -1]    # (B, H)
        d      = np.maximum(0, h_last @ Wd + bd)
        p      = softmax(d @ Wo + bo)

        # Output layer backprop
        dL = p.copy(); dL[np.arange(nb), yb] -= 1; dL /= nb
        dWo = d.T @ dL;   dbo = dL.sum(0, keepdims=True)
        dd  = (dL @ Wo.T) * (h_last @ Wd + bd > 0)
        dWd = h_last.T @ dd; dbd = dd.sum(0, keepdims=True)

        # Backprop through last LSTM hidden state
        dh = dd @ Wd.T

        # BPTT (simplified — only through last time step for speed)
        g    = g_all[:, -1]
        ig   = sigmoid(g[:, :H]);    fg = sigmoid(g[:, H:2*H])
        gg   = tanh(g[:, 2*H:3*H]); og = sigmoid(g[:, 3*H:])
        c_t  = c_all[:, -1]
        c_tm1= c_all[:, -2] if SEQ_LEN > 1 else np.zeros_like(c_t)

        do   = dh * tanh(c_t);  dc = dh * og * (1 - tanh(c_t)**2)
        di   = dc * gg;         df = dc * c_tm1; dg_ = dc * ig
        dig  = di * ig * (1-ig); dfg = df * fg * (1-fg)
        dgg  = dg_ * (1-gg**2);  dog = do * og * (1-og)
        dG   = np.concatenate([dig, dfg, dgg, dog], axis=1)

        x_t  = Xb[:, -1]
        h_tm1= h_all[:, -2] if SEQ_LEN > 1 else np.zeros((B, H), np.float32)
        dWx  = x_t.T @ dG;  dWh_ = h_tm1.T @ dG; db_ = dG.sum(0, keepdims=True)

        for g_ in [dWo,dbo,dWd,dbd,dWx,dWh_,db_]: np.clip(g_, -5, 5, out=g_)

        Wo -= lr*dWo;  bo -= lr*dbo
        Wd -= lr*dWd;  bd -= lr*dbd
        Wx -= lr*dWx;  Wh -= lr*dWh_; b_ -= lr*db_

    lr *= DECAY

    if (ep+1) % 10 == 0:
        _, _, pt  = forward(X_tr[:200])
        preds     = forward(X_te)[-1].argmax(1)
        acc       = accuracy_score(y_te, preds)
        print(f"  Epoch {ep+1:3d}  loss={xloss(pt, y_tr[:200]):.4f}  test_acc={acc*100:.1f}%")
        if acc > best_acc:
            best_acc = acc
            best_w = [Wx.copy(), Wh.copy(), b_.copy(), Wd.copy(), bd.copy(), Wo.copy(), bo.copy()]

if best_w: Wx, Wh, b_, Wd, bd, Wo, bo = best_w
preds = forward(X_te)[-1].argmax(1)
acc   = accuracy_score(y_te, preds)
print(f"\n  Best: {best_acc*100:.1f}%   Final: {acc*100:.1f}%")
if len(LABELS) <= 20:
    print(classification_report(y_te, preds, target_names=LABELS, digits=2))

# ── Export TF.js model ─────────────────────────────────────────────────────────
OUT = Path(__file__).parent.parent / "js" / "gesture_model"
OUT.mkdir(parents=True, exist_ok=True)

params = [Wx, Wh, b_, Wd, bd, Wo, bo]
names  = ["lstm/Wx","lstm/Wh","lstm/b","dense/W","dense/b","out/W","out/b"]
blob   = np.concatenate([p.flatten() for p in params])
raw_b  = struct.pack(f'<{len(blob)}f', *blob.tolist())
shard  = "group1-shard1of1.bin"
with open(OUT/shard, 'wb') as f: f.write(raw_b)

specs = []; off = 0
for nm, p in zip(names, params):
    nb = p.size * 4
    specs.append({"name": nm, "shape": list(p.shape), "dtype": "float32",
                  "byteOffset": off, "byteLength": nb})
    off += nb

model_json = {
    "format":       "lstm-model",
    "generatedBy":  "SignConnect-LSTM",
    "modelType":    "lstm",
    "seqLen":       SEQ_LEN,
    "frameSize":    FRAME_SIZE,
    "hiddenUnits":  H,
    "labels":       LABELS,
    "weightsManifest": [{"paths": [shard], "weights": specs}]
}
with open(OUT/'model.json', 'w') as f: json.dump(model_json, f, indent=2)
print(f"\n  Exported to js/gesture_model/  ({len(raw_b)//1024} KB)  {N} labels")
print(f"  Restart the server and test!")

"""
retrain_normalized.py
Reloads cached landmarks, applies feature engineering for better accuracy,
retrains a deeper model, exports TF.js model.

Run:  python ml-server/retrain_normalized.py
"""
import os, json, struct
import numpy as np
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics import accuracy_score, classification_report

CACHE  = Path(__file__).parent / "asl_dataset" / "landmarks.npz"
OUT    = Path(__file__).parent.parent / "js" / "gesture_model"
OUT.mkdir(parents=True, exist_ok=True)

# ── Load cached landmarks ──────────────────────────────────────────────────────
print("Loading cached landmarks...")
data   = np.load(str(CACHE), allow_pickle=True)
X_raw  = data["X"]          # (N, 63) raw x,y,z
y_raw  = data["y"]
print(f"  {len(X_raw)} real samples, {len(set(y_raw))} classes")

# ── Feature engineering ────────────────────────────────────────────────────────
# Raw (x,y,z) is scale/position dependent.
# We compute RELATIVE features that are invariant to hand size & position.

def engineer_features(lm63):
    """
    Input:  63-float array [x0,y0,z0, x1,y1,z1, ..., x20,y20,z20]
    Output: 126-float feature vector:
      - 63 normalized (wrist-centered, palm-size-divided) coords
      - 21 fingertip-to-wrist distances (normalized)
      - 20 consecutive-joint angles (dot product)
      - 20 joint-to-joint y-deltas (encodes curl direction)
    """
    pts = lm63.reshape(21, 3)
    wrist  = pts[0]
    # Palm size = distance wrist to middle MCP (landmark 9)
    psize  = np.linalg.norm(pts[9] - wrist) + 1e-6

    # 1. Normalized coords (wrist-centred, scale-normalised)
    norm   = (pts - wrist) / psize               # (21,3)
    feat1  = norm.flatten()                      # 63

    # 2. Fingertip distances to wrist (normalised)
    tips   = [4, 8, 12, 16, 20]
    feat2  = np.array([np.linalg.norm(pts[t] - wrist) / psize for t in tips])  # 5

    # 3. Finger extension ratio: tip_y vs pip_y (normalised by palm)
    pairs  = [(8,7),(12,11),(16,15),(20,19),(4,3)]
    feat3  = np.array([(pts[a][1] - pts[b][1]) / psize for a,b in pairs])      # 5

    # 4. Per-finger curl: tip_y - mcp_y  (positive = curled, negative = extended)
    mcp    = [5, 9, 13, 17, 2]
    feat4  = np.array([(pts[tips[i]][1] - pts[mcp[i]][1]) / psize
                       for i in range(5)])                                       # 5

    # 5. Thumb lateral: how far thumb tip is from index MCP (x direction)
    feat5  = np.array([(pts[4][0] - pts[5][0]) / psize])                       # 1

    # 6. Angle between consecutive segments for each finger
    finger_chains = [
        [0,1,2,3,4],    # thumb
        [0,5,6,7,8],    # index
        [0,9,10,11,12], # middle
        [0,13,14,15,16],# ring
        [0,17,18,19,20],# pinky
    ]
    angles = []
    for chain in finger_chains:
        for i in range(len(chain)-2):
            a, b, c = pts[chain[i]], pts[chain[i+1]], pts[chain[i+2]]
            ab = a - b; cb = c - b
            cos = np.dot(ab,cb) / (np.linalg.norm(ab)*np.linalg.norm(cb)+1e-9)
            angles.append(np.clip(cos, -1, 1))
    feat6 = np.array(angles)   # 15

    return np.concatenate([feat1, feat2, feat3, feat4, feat5, feat6]).astype(np.float32)

print("Engineering features...")
FEAT_DIM = len(engineer_features(X_raw[0]))
print(f"  Feature dimension: {FEAT_DIM}")

X = np.array([engineer_features(x) for x in X_raw], dtype=np.float32)
print(f"  Feature matrix: {X.shape}")

# ── Add synthetic common words ─────────────────────────────────────────────────
SYNTH_EXTRAS = {
    "Hello":      {"f":[1,1,1,1,1], "tx": 1,  "spread":1.4},
    "Yes":        {"f":[0,0,0,0,0], "tx":-0.5,"spread":0.3},
    "No":         {"f":[0,1,0,0,0], "tx": 0,  "spread":0.4},
    "Stop":       {"f":[0,1,1,1,1], "tx": 0,  "spread":0.9},
    "Good":       {"f":[0,0,0,0,0], "tx": 1,  "spread":0.3, "ty":-0.25},
    "Bad":        {"f":[0,0,0,0,0], "tx": 1,  "spread":0.3, "ty": 0.15},
    "Peace":      {"f":[0,1,1,0,0], "tx": 0,  "spread":0.6},
    "Thank You":  {"f":[1,1,1,1,1], "tx": 0,  "spread":0.5, "horiz":True},
    "Help":       {"f":[0,0,0,0,0], "tx": 1,  "spread":0.4, "ty":-0.15},
    "Sorry":      {"f":[0,0,0,0,0], "tx":-1,  "spread":0.3},
    "I Love You": {"f":[1,1,0,0,1], "tx": 1,  "spread":1.2},
    "Water":      {"f":[0,1,1,1,0], "tx": 0,  "spread":0.7},
    "More":       {"f":[0.5,0.5,0.5,0.5,0.5],"tx":0,"spread":0.5},
    "Please":     {"f":[1,1,1,1,1], "tx": 0,  "spread":0.4, "horiz":True},
    "Finished":   {"f":[1,1,1,1,1], "tx": 1,  "spread":1.0},
    "Friend":     {"f":[0,1,1,0,0], "tx": 0,  "spread":0.4},
    "Me":         {"f":[0,1,0,0,0], "tx": 0,  "spread":0.3, "pdown":True},
    "You":        {"f":[0,1,0,0,0], "tx": 0,  "spread":0.3},
    "OK":         {"f":[0.5,0.5,1,1,1],"tx":0.5,"spread":0.7},
}

def make_synth(g):
    f=g["f"]; tx=g.get("tx",0); spr=g.get("spread",0.7)
    horiz=g.get("horiz",False); ty=g.get("ty",0); pdown=g.get("pdown",False)
    lm=np.zeros(63,dtype=np.float32)
    wx=0.5+np.random.normal(0,.04); wy=0.72+np.random.normal(0,.03)
    lm[0:3]=[wx,wy,0]
    layout=[(4,3,2,-.12),(8,7,6,-.06),(12,11,10,.00),(16,15,14,.06),(20,19,18,.12)]
    for fi,(tip,pip,mcp,bx) in enumerate(layout):
        ext=f[fi]; bx_a=wx+bx*spr+np.random.normal(0,.012)
        mcp_y=wy-.10+np.random.normal(0,.01)
        lm[mcp*3]=bx_a; lm[mcp*3+1]=mcp_y; lm[mcp*3+2]=np.random.normal(0,.008)
        if horiz:
            dx=.09*(1 if bx>=0 else -1)
            lm[pip*3]=bx_a+dx; lm[pip*3+1]=mcp_y+np.random.normal(0,.01)
            lm[tip*3]=bx_a+2*dx; lm[tip*3+1]=mcp_y+np.random.normal(0,.01)
        elif ext>=.8:
            py=mcp_y-.085+np.random.normal(0,.01); ty2=py-.085+np.random.normal(0,.01)
            if pdown and fi==1: py=mcp_y+.05; ty2=py+.08
            lm[pip*3]=bx_a+np.random.normal(0,.01); lm[pip*3+1]=py
            lm[tip*3]=bx_a+np.random.normal(0,.01); lm[tip*3+1]=ty2
        elif ext<=.2:
            py=mcp_y-.035+np.random.normal(0,.01); ty2=wy-.04+np.random.normal(0,.01)
            lm[pip*3]=bx_a+np.random.normal(0,.01); lm[pip*3+1]=py
            lm[tip*3]=bx_a+np.random.normal(0,.01); lm[tip*3+1]=ty2
        else:
            py=mcp_y-.055+np.random.normal(0,.01); ty2=py-.01+np.random.normal(0,.01)
            lm[pip*3]=bx_a+np.random.normal(0,.01); lm[pip*3+1]=py
            lm[tip*3]=bx_a+np.random.normal(0,.01); lm[tip*3+1]=ty2
        lm[pip*3+2]=np.random.normal(0,.008); lm[tip*3+2]=np.random.normal(0,.008)
    lm[12]=wx+tx*.12+np.random.normal(0,.012)
    lm[13]=lm[13]+ty+np.random.normal(0,.01)
    return engineer_features(np.clip(lm,0,1))

print("Adding synthetic common-word gestures...")
Xs, ys = [], []
for name, gdef in SYNTH_EXTRAS.items():
    for _ in range(1000):
        Xs.append(make_synth(gdef))
        ys.append(name)
X_s = np.array(Xs, dtype=np.float32)
y_s = np.array(ys)

X = np.vstack([X, X_s])
y = np.concatenate([y_raw, y_s])
print(f"  Combined: {len(X)} samples")

# ── Encode labels ──────────────────────────────────────────────────────────────
le = LabelEncoder()
y_enc = le.fit_transform(y)
LABELS = le.classes_.tolist()
N = len(LABELS)
print(f"  {N} total classes: {LABELS}")

X_tr,X_te,y_tr,y_te = train_test_split(X, y_enc, test_size=0.1, stratify=y_enc, random_state=42)
print(f"  Train: {len(X_tr)}  Test: {len(X_te)}")

# ── Deep MLP ───────────────────────────────────────────────────────────────────
np.random.seed(42)
def he(a,b): return (np.random.randn(a,b)*np.sqrt(2/a)).astype(np.float32)

# 5-layer net on engineered features
W1,b1=he(FEAT_DIM,512), np.zeros((1,512),np.float32)
W2,b2=he(512,256),      np.zeros((1,256),np.float32)
W3,b3=he(256,128),      np.zeros((1,128),np.float32)
W4,b4=he(128,64),       np.zeros((1,64), np.float32)
W5,b5=he(64,N),         np.zeros((1,N),  np.float32)

relu=lambda x: np.maximum(0,x)
dr  =lambda x: (x>0).astype(np.float32)
def sfmx(x):
    e=np.exp(x-x.max(1,keepdims=True)); return e/e.sum(1,keepdims=True)

def fwd(X):
    a1=relu(X@W1+b1); a2=relu(a1@W2+b2)
    a3=relu(a2@W3+b3); a4=relu(a3@W4+b4)
    a5=sfmx(a4@W5+b5)
    return a1,a2,a3,a4,a5

def xloss(p,y): return -np.log(p[np.arange(len(y)),y]+1e-9).mean()

EPOCHS=200; LR=0.003; BS=256; DECAY=0.99; lr=LR; n=len(X_tr)
best_acc=0; best_w=None

print(f"Training ({EPOCHS} epochs, {FEAT_DIM}-dim features)...")
for ep in range(EPOCHS):
    ix=np.random.permutation(n)
    for i in range(0,n,BS):
        Xb=X_tr[ix[i:i+BS]]; yb=y_tr[ix[i:i+BS]]; nb=len(yb)
        a1,a2,a3,a4,p=fwd(Xb)
        dz5=p.copy(); dz5[np.arange(nb),yb]-=1; dz5/=nb
        dW5=a4.T@dz5; db5=dz5.sum(0,keepdims=True)
        z4=a3@W4+b4; dz4=(dz5@W5.T)*dr(z4)
        dW4=a3.T@dz4; db4=dz4.sum(0,keepdims=True)
        z3=a2@W3+b3; dz3=(dz4@W4.T)*dr(z3)
        dW3=a2.T@dz3; db3=dz3.sum(0,keepdims=True)
        z2=a1@W2+b2; dz2=(dz3@W3.T)*dr(z2)
        dW2=a1.T@dz2; db2=dz2.sum(0,keepdims=True)
        z1=Xb@W1+b1;  dz1=(dz2@W2.T)*dr(z1)
        dW1=Xb.T@dz1; db1=dz1.sum(0,keepdims=True)
        for g in [dW1,db1,dW2,db2,dW3,db3,dW4,db4,dW5,db5]: np.clip(g,-5,5,out=g)
        W1-=lr*dW1; b1-=lr*db1; W2-=lr*dW2; b2-=lr*db2; W3-=lr*dW3; b3-=lr*db3
        W4-=lr*dW4; b4-=lr*db4; W5-=lr*dW5; b5-=lr*db5
    lr*=DECAY
    if (ep+1)%20==0:
        _,_,_,_,pt=fwd(X_tr); acc=accuracy_score(y_te,fwd(X_te)[-1].argmax(1))
        print(f"  Epoch {ep+1:3d}  loss={xloss(pt,y_tr):.4f}  test_acc={acc*100:.1f}%")
        if acc>best_acc:
            best_acc=acc
            best_w=[W1.copy(),b1.copy(),W2.copy(),b2.copy(),W3.copy(),b3.copy(),
                    W4.copy(),b4.copy(),W5.copy(),b5.copy()]

if best_w: W1,b1,W2,b2,W3,b3,W4,b4,W5,b5=best_w
acc=accuracy_score(y_te,fwd(X_te)[-1].argmax(1))
print(f"\n  Best: {best_acc*100:.1f}%   Final: {acc*100:.1f}%")
print(classification_report(y_te, fwd(X_te)[-1].argmax(1), target_names=LABELS, digits=2))

# ── Export ─────────────────────────────────────────────────────────────────────
params=[W1,b1,W2,b2,W3,b3,W4,b4,W5,b5]
names=["d0/k","d0/b","d1/k","d1/b","d2/k","d2/b","d3/k","d3/b","d4/k","d4/b"]
blob=np.concatenate([p.flatten() for p in params])
raw=struct.pack(f'<{len(blob)}f',*blob.tolist())
shard="group1-shard1of1.bin"
with open(OUT/shard,'wb') as f: f.write(raw)
specs=[]; off=0
for nm,p in zip(names,params):
    nb=p.size*4
    specs.append({"name":nm,"shape":list(p.shape),"dtype":"float32","byteOffset":off,"byteLength":nb})
    off+=nb
mjson={"format":"layers-model","generatedBy":"SignConnect-NormFeatures","convertedBy":None,
  "featureDim": FEAT_DIM,
  "modelTopology":{"class_name":"Sequential","config":{"name":"gesture_norm","layers":[
    {"class_name":"Dense","config":{"name":"d0","units":512,"activation":"relu","use_bias":True,"batch_input_shape":[None,FEAT_DIM]}},
    {"class_name":"Dense","config":{"name":"d1","units":256,"activation":"relu","use_bias":True}},
    {"class_name":"Dense","config":{"name":"d2","units":128,"activation":"relu","use_bias":True}},
    {"class_name":"Dense","config":{"name":"d3","units":64, "activation":"relu","use_bias":True}},
    {"class_name":"Dense","config":{"name":"d4","units":N,  "activation":"softmax","use_bias":True}},
  ]}},
  "weightsManifest":[{"paths":[shard],"weights":specs}],
  "labels":LABELS
}
with open(OUT/'model.json','w') as f: json.dump(mjson,f,indent=2)
print(f"\n  Exported {OUT}  ({len(raw)//1024} KB)  {N} labels")

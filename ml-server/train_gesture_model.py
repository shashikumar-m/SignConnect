"""
train_gesture_model.py  v2
Trains MLP on synthetic MediaPipe landmarks, exports TF.js LayersModel.
Run:  python ml-server/train_gesture_model.py
"""
import os, json, struct
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics import accuracy_score

# Gestures: f=[thumb,index,middle,ring,pinky] (1=up,0=curl,0.5=half)
# tx = thumb lateral spread  (1=wide right, -1=tucked left)
GESTURES = {
    "Hello":      {"f":[1,1,1,1,1], "tx": 1,    "spread":1.4},
    "I Love You": {"f":[1,1,0,0,1], "tx": 1,    "spread":1.2},
    "Yes":        {"f":[0,0,0,0,0], "tx":-0.5,  "spread":0.3},
    "No":         {"f":[0,1,0,0,0], "tx": 0,    "spread":0.4},
    "Stop":       {"f":[0,1,1,1,1], "tx": 0,    "spread":0.9},
    "Good":       {"f":[0,0,0,0,0], "tx": 1,    "spread":0.3, "ty":-0.25},
    "Bad":        {"f":[0,0,0,0,0], "tx": 1,    "spread":0.3, "ty": 0.15},
    "Peace":      {"f":[0,1,1,0,0], "tx": 0,    "spread":0.6},
    "Thank You":  {"f":[1,1,1,1,1], "tx": 0,    "spread":0.5, "horiz":True},
    "Help":       {"f":[0,0,0,0,0], "tx": 1,    "spread":0.4, "ty":-0.15},
    "Sorry":      {"f":[0,0,0,0,0], "tx":-1,    "spread":0.3},
    "Please":     {"f":[1,1,1,1,1], "tx": 0,    "spread":0.4, "horiz":True},
    "More":       {"f":[0.5,0.5,0.5,0.5,0.5],"tx":0,"spread":0.5},
    "Finished":   {"f":[1,1,1,1,1], "tx": 1,    "spread":1.0},
    "Water":      {"f":[0,1,1,1,0], "tx": 0,    "spread":0.7},
    "Eat":        {"f":[0.5,0.5,0.5,0.5,0],"tx":0.5,"spread":0.4},
    "Me":         {"f":[0,1,0,0,0], "tx": 0,    "spread":0.3, "pdown":True},
    "You":        {"f":[0,1,0,0,0], "tx": 0,    "spread":0.3},
    "Friend":     {"f":[0,1,1,0,0], "tx": 0,    "spread":0.4},
    "OK":         {"f":[0.5,0.5,1,1,1],"tx":0.5,"spread":0.7},
    "Y":          {"f":[0,0,0,0,1], "tx": 1,    "spread":0.8},
    "L":          {"f":[0,1,0,0,0], "tx": 1,    "spread":0.7},
    "A":          {"f":[0,0,0,0,0], "tx": 0.5,  "spread":0.2},
    "B":          {"f":[1,1,1,1,1], "tx":-1,    "spread":0.5},
    "C":          {"f":[0.5,0.5,0.5,0.5,0.5],"tx":0.5,"spread":0.6,"curve":True},
    "D":          {"f":[0,1,0,0,0], "tx": 0.5,  "spread":0.4},
    "I":          {"f":[0,0,0,0,1], "tx": 0,    "spread":0.4},
    "O":          {"f":[0.5,0.5,0.5,0.5,0.5],"tx":0.5,"spread":0.3,"curve":True},
    "V":          {"f":[0,1,1,0,0], "tx": 0,    "spread":0.8},
    "W":          {"f":[0,1,1,1,0], "tx": 0,    "spread":0.9},
}

LABELS = sorted(GESTURES.keys())
N = len(LABELS)
print(f"Training on {N} gestures: {LABELS}")


def make_sample(g):
    f      = g["f"]
    tx     = g.get("tx", 0)
    spr    = g.get("spread", 0.7)
    horiz  = g.get("horiz", False)
    curve  = g.get("curve", False)
    ty     = g.get("ty", 0)
    pdown  = g.get("pdown", False)

    lm = np.zeros(63, dtype=np.float32)
    wx = 0.5  + np.random.normal(0, 0.04)
    wy = 0.72 + np.random.normal(0, 0.03)
    lm[0:3] = [wx, wy, 0.0]

    # (tip_idx, pip_idx, mcp_idx, x_base_offset)
    layout = [(4,3,2,-0.12),(8,7,6,-0.06),(12,11,10,0.00),(16,15,14,0.06),(20,19,18,0.12)]

    for fi,(tip,pip,mcp,bx) in enumerate(layout):
        ext   = f[fi]
        bx_a  = wx + bx * spr + np.random.normal(0, 0.012)
        mcp_y = wy - 0.10 + np.random.normal(0, 0.01)
        lm[mcp*3]   = bx_a
        lm[mcp*3+1] = mcp_y
        lm[mcp*3+2] = np.random.normal(0, 0.008)

        if horiz:
            dx = 0.09 * (1 if bx >= 0 else -1)
            lm[pip*3]=bx_a+dx; lm[pip*3+1]=mcp_y+np.random.normal(0,0.01)
            lm[tip*3]=bx_a+2*dx; lm[tip*3+1]=mcp_y+np.random.normal(0,0.01)
        elif ext >= 0.8:
            pip_y = mcp_y - 0.085 + np.random.normal(0,0.01)
            tip_y = pip_y - 0.085 + np.random.normal(0,0.01)
            if pdown and fi == 1:
                pip_y = mcp_y + 0.05; tip_y = pip_y + 0.08
            lm[pip*3]=bx_a+np.random.normal(0,0.01); lm[pip*3+1]=pip_y
            lm[tip*3]=bx_a+np.random.normal(0,0.01); lm[tip*3+1]=tip_y
        elif ext <= 0.2:
            pip_y = mcp_y - 0.035 + np.random.normal(0,0.01)
            tip_y = wy - 0.04 + np.random.normal(0,0.01)
            lm[pip*3]=bx_a+np.random.normal(0,0.01); lm[pip*3+1]=pip_y
            lm[tip*3]=bx_a+np.random.normal(0,0.01); lm[tip*3+1]=tip_y
        else:
            pip_y = mcp_y - 0.055 + np.random.normal(0,0.01)
            tip_y = pip_y - 0.01  + np.random.normal(0,0.01)
            cx = 0.04 * np.sign(bx) if curve else 0
            lm[pip*3]=bx_a+cx+np.random.normal(0,0.01); lm[pip*3+1]=pip_y
            lm[tip*3]=bx_a+cx*1.5+np.random.normal(0,0.01); lm[tip*3+1]=tip_y
        lm[pip*3+2] = np.random.normal(0,0.008)
        lm[tip*3+2] = np.random.normal(0,0.008)

    # Thumb tip position
    lm[12] = wx + tx * 0.12 + np.random.normal(0,0.012)
    lm[13] = lm[13] + ty + np.random.normal(0,0.01)
    return np.clip(lm, 0, 1)


print("Generating data...")
X_list, y_list = [], []
for label in LABELS:
    for _ in range(800):
        X_list.append(make_sample(GESTURES[label]))
    y_list.extend([label]*800)

X  = np.array(X_list, dtype=np.float32)
le = LabelEncoder()
y  = le.fit_transform(y_list)
X_tr,X_te,y_tr,y_te = train_test_split(X, y, test_size=0.15, stratify=y, random_state=42)
print(f"  {X_tr.shape[0]} train  {X_te.shape[0]} test  {N} classes")


# 4-layer MLP: 63->256->128->64->N
np.random.seed(42)
def he(a,b): return (np.random.randn(a,b)*np.sqrt(2/a)).astype(np.float32)
W1,b1 = he(63,256),  np.zeros((1,256),np.float32)
W2,b2 = he(256,128), np.zeros((1,128),np.float32)
W3,b3 = he(128,64),  np.zeros((1,64), np.float32)
W4,b4 = he(64,N),    np.zeros((1,N),  np.float32)

relu  = lambda x: np.maximum(0,x)
drelu = lambda x: (x>0).astype(np.float32)
def sfmx(x):
    e=np.exp(x-x.max(1,keepdims=True)); return e/e.sum(1,keepdims=True)
def fwd(X):
    a1=relu(X@W1+b1); a2=relu(a1@W2+b2)
    a3=relu(a2@W3+b3); a4=sfmx(a3@W4+b4)
    return a1,a2,a3,a4
def xloss(p,y): return -np.log(p[np.arange(len(y)),y]+1e-9).mean()

EPOCHS=120; LR=0.01; BS=128; DECAY=0.98; lr=LR; n=X_tr.shape[0]
print("Training (120 epochs)...")

for ep in range(EPOCHS):
    ix=np.random.permutation(n)
    for i in range(0,n,BS):
        Xb,yb=X_tr[ix[i:i+BS]],y_tr[ix[i:i+BS]]; nb=len(yb)
        a1,a2,a3,p=fwd(Xb)
        dz4=p.copy(); dz4[np.arange(nb),yb]-=1; dz4/=nb
        dW4=a3.T@dz4; db4=dz4.sum(0,keepdims=True)
        z3=a2@W3+b3; dz3=(dz4@W4.T)*drelu(z3)
        dW3=a2.T@dz3; db3=dz3.sum(0,keepdims=True)
        z2=a1@W2+b2; dz2=(dz3@W3.T)*drelu(z2)
        dW2=a1.T@dz2; db2=dz2.sum(0,keepdims=True)
        z1=Xb@W1+b1;  dz1=(dz2@W2.T)*drelu(z1)
        dW1=Xb.T@dz1; db1=dz1.sum(0,keepdims=True)
        for g in [dW1,db1,dW2,db2,dW3,db3,dW4,db4]: np.clip(g,-5,5,out=g)
        W1-=lr*dW1; b1-=lr*db1; W2-=lr*dW2; b2-=lr*db2
        W3-=lr*dW3; b3-=lr*db3; W4-=lr*dW4; b4-=lr*db4
    lr*=DECAY
    if (ep+1)%20==0:
        _,_,_,pt=fwd(X_tr); acc=accuracy_score(y_te,fwd(X_te)[-1].argmax(1))
        print(f"  Epoch {ep+1:3d}  loss={xloss(pt,y_tr):.4f}  test_acc={acc*100:.1f}%")

acc=accuracy_score(y_te,fwd(X_te)[-1].argmax(1))
print(f"\n  Final accuracy: {acc*100:.1f}%")


# Export TF.js LayersModel
OUT=os.path.join(os.path.dirname(__file__),'..','js','gesture_model')
os.makedirs(OUT, exist_ok=True)
params=[W1,b1,W2,b2,W3,b3,W4,b4]
names=["d0/kernel","d0/bias","d1/kernel","d1/bias","d2/kernel","d2/bias","d3/kernel","d3/bias"]
blob=np.concatenate([p.flatten() for p in params])
raw=struct.pack(f'<{len(blob)}f',*blob.tolist())
with open(os.path.join(OUT,'group1-shard1of1.bin'),'wb') as fh: fh.write(raw)
specs=[]; off=0
for nm,p in zip(names,params):
    nb=p.size*4
    specs.append({"name":nm,"shape":list(p.shape),"dtype":"float32","byteOffset":off,"byteLength":nb})
    off+=nb
mjson={"format":"layers-model","generatedBy":"SignConnect-v2","convertedBy":None,
  "modelTopology":{"class_name":"Sequential","config":{"name":"gesture_mlp","layers":[
    {"class_name":"Dense","config":{"name":"d0","units":256,"activation":"relu","use_bias":True,"batch_input_shape":[None,63]}},
    {"class_name":"Dense","config":{"name":"d1","units":128,"activation":"relu","use_bias":True}},
    {"class_name":"Dense","config":{"name":"d2","units":64, "activation":"relu","use_bias":True}},
    {"class_name":"Dense","config":{"name":"d3","units":N,  "activation":"softmax","use_bias":True}},
  ]}},
  "weightsManifest":[{"paths":["group1-shard1of1.bin"],"weights":specs}],
  "labels":LABELS
}
with open(os.path.join(OUT,'model.json'),'w') as fh: json.dump(mjson,fh,indent=2)
print(f"  Exported js/gesture_model/  ({len(raw)//1024} KB)  {N} labels")

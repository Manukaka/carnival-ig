# Original brand music bed (royalty-free, generated). Usage: python3 music.py out.wav seconds "hits=0.15,14.4" "whoosh=2.4,7.2,12.0"
import numpy as np, wave, sys
out=sys.argv[1]; dur=float(sys.argv[2]); opts=dict(a.split('=') for a in sys.argv[3:])
hits=[float(x) for x in opts.get('hits','').split(',') if x]; whs=[float(x) for x in opts.get('whoosh','').split(',') if x]
sr=44100; bpm=100; beat=60/bpm; bar=4*beat
t=np.arange(int(sr*dur))/sr; L=np.zeros_like(t); R=np.zeros_like(t)
rng=np.random.default_rng(7)
def f(n): return 440*2**((n-69)/12)
def add(start,sig,pan=0.0,g=1.0):
    i=int(start*sr)
    if i>=len(t): return
    j=min(len(t),i+len(sig)); s=sig[:j-i]*g
    L[i:j]+=s*(1-pan); R[i:j]+=s*(1+pan)
def tone(fr,d,dec=3.0,att=0.005,harm=(1,.5,.25)):
    u=np.arange(int(sr*d))/sr; env=np.minimum(1,u/att)*np.exp(-u*dec)
    return env*sum(a*np.sin(2*np.pi*fr*(k+1)*u) for k,a in enumerate(harm))
MOODS={'warm':[[45,57,60,64],[41,53,57,60],[48,55,60,64],[43,55,59,62]],   # Am F C G
       'bright':[[48,55,60,64],[43,55,59,62],[45,57,60,64],[41,53,57,60]], # C G Am F
       'dark':[[38,50,53,57],[46,50,53,58],[41,53,57,60],[48,52,55,60]],   # Dm Bb F C
       'festive':[[50,54,57,62],[45,52,57,61],[47,54,59,62],[43,55,59,62]]} # D A Bm G
prog=MOODS.get(opts.get('mood','warm'),MOODS['warm'])
nb=int(dur/bar)+1
for b in range(nb):
    s=b*bar; ch=prog[b%4]
    add(s,tone(f(ch[0]-12),bar,dec=0.6,att=0.02,harm=(1,.3)),g=0.22)               # sub bass
    for n in ch[1:]: add(s,tone(f(n),bar,dec=0.45,att=0.25,harm=(1,.35,.12)),g=0.07)  # pad
    if b>=1:                                                                       # piano plucks 8ths
        for k in range(8):
            n=ch[1:][[0,1,2,1,0,2,1,2][k]]+12
            add(s+k*beat/2,tone(f(n),0.6,dec=6,harm=(1,.4,.15,.05)),pan=-.3+.6*(k%2),g=0.10)
    if b>=1:                                                                       # kick + hat
        for k in range(4):
            u=np.arange(int(sr*.35))/sr; add(s+k*beat,np.exp(-u*14)*np.sin(2*np.pi*(48+110*np.exp(-u*35))*u),g=0.55)
        for k in range(8):
            u=np.arange(int(sr*.06))/sr; add(s+k*beat/2+beat/4,rng.normal(0,1,len(u))*np.exp(-u*80),pan=.4,g=0.04)
for h in hits:  # cinematic impact
    u=np.arange(int(sr*2.2))/sr
    sig=np.exp(-u*2.2)*np.sin(2*np.pi*(38+60*np.exp(-u*9))*u)*0.9+rng.normal(0,1,len(u))*np.exp(-u*7)*0.25
    add(h,sig,g=0.7)
for w in whs:   # whoosh into transition
    d=0.7; u=np.arange(int(sr*d))/sr; n=rng.normal(0,1,len(u))
    env=np.sin(np.pi*u/d)**2; n=np.convolve(n,np.ones(12)/12,'same')
    add(max(0,w-0.45),n*env,pan=0,g=0.35)
fade=np.minimum(1,np.minimum(t/0.4,(dur-t)/1.2)); L*=fade; R*=fade
m=max(np.abs(L).max(),np.abs(R).max()); L,R=L/m*0.89,R/m*0.89
st=np.empty(len(t)*2,np.int16); st[0::2]=(L*32767).astype(np.int16); st[1::2]=(R*32767).astype(np.int16)
wv=wave.open(out,'w'); wv.setnchannels(2); wv.setsampwidth(2); wv.setframerate(sr); wv.writeframes(st.tobytes()); wv.close()

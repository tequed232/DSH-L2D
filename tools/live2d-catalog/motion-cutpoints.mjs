// 扫描 motion3.json，按曲线速度找「可衔接点」：所有曲线都接近静止的时间窗。
// 用法：node motion-cutpoints.mjs <模型目录> > cutpoints.json   （模型文件不入库，只输出时间数据）
import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2];
const model3 = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.dsl2d.2048.model3.json'))), 'utf8'));
function sampler(seg) { // 返回 t->v
  const pts = []; let i = 2; let p = [seg[0], seg[1]];
  const parts = [];
  while (i < seg.length) {
    const type = seg[i];
    if (type === 1) { const c = [seg[i+1],seg[i+2],seg[i+3],seg[i+4],seg[i+5],seg[i+6]]; parts.push({type, p0:p, c1:[c[0],c[1]], c2:[c[2],c[3]], p1:[c[4],c[5]]}); p=[c[4],c[5]]; i+=7; }
    else { const p1=[seg[i+1],seg[i+2]]; parts.push({type,p0:p,p1}); p=p1; i+=3; }
  }
  return t => { for (const s of parts) { if (t <= s.p1[0]) {
      const u = (t - s.p0[0]) / ((s.p1[0] - s.p0[0]) || 1);
      if (s.type === 0) return s.p0[1] + (s.p1[1]-s.p0[1])*u;
      if (s.type === 2) return s.p0[1]; if (s.type === 3) return s.p1[1];
      let lo=0,hi=1; for (let k=0;k<20;k++){const m=(lo+hi)/2;const x=(1-m)**3*s.p0[0]+3*(1-m)**2*m*s.c1[0]+3*(1-m)*m*m*s.c2[0]+m**3*s.p1[0];x<t?lo=m:hi=m;}
      const m=lo; return (1-m)**3*s.p0[1]+3*(1-m)**2*m*s.c1[1]+3*(1-m)*m*m*s.c2[1]+m**3*s.p1[1]; } }
    return parts.length ? parts.at(-1).p1[1] : seg[1]; };
}
const out = { schemaVersion: 1, modelId: '大肥鱼.dsl2d.2048', method: '30fps 采样，每条参数曲线按自身振幅归一化，取所有曲线最大速度；速度低于本动作峰值 25% 且持续 ≥ 0.1 秒的时间窗记为可衔接窗；Movement* 是 0/1 开关曲线，不计入速度', motions: {} };
for (const [group, arr] of Object.entries(model3.FileReferences.Motions)) for (const e of arr) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, e.File), 'utf8')); const D = m.Meta.Duration;
  const curves = m.Curves.filter(c => c.Target === 'Parameter').map(c => { const f = sampler(c.Segments); const vs=[]; for (let t=0;t<=D;t+=1/30) vs.push(f(t)); const amp = Math.max(...vs)-Math.min(...vs); return { id:c.Id, vs, amp, stepped: !c.Segments.slice(2).some((x,i)=>i===0) || /^Movement/.test(c.Id) }; }).filter(c => c.amp > 1e-6 && !c.stepped);
  const n = Math.floor(D*30)+1, speed = [];
  for (let k=0;k<n;k++){ let s=0; for (const c of curves){ const a=c.vs[Math.max(0,k-1)], b=c.vs[Math.min(c.vs.length-1,k+1)]; s=Math.max(s, Math.abs(b-a)/(2/30)/c.amp);} speed.push(s); }
  const wins=[]; let st=null;
  for (let k=0;k<n;k++){ const ok=speed[k]<0.25*Math.max(...speed); if(ok&&st===null)st=k; if((!ok||k===n-1)&&st!==null){const en=ok?k:k-1; if((en-st)/30>=0.1)wins.push([+(st/30).toFixed(2),+(en/30).toFixed(2)]); st=null;} }
  const peak = speed.indexOf(Math.max(...speed));
  const sw = m.Curves.filter(c=>/^Movement/.test(c.Id)).map(c=>{const f=sampler(c.Segments);const v0=f(0);for(let t=0;t<=D;t+=1/60)if(Math.abs(f(t)-v0)>0.5)return +t.toFixed(2);return null;}).filter(x=>x!==null);
  const switchAt = sw.length?Math.min(...sw):null;
  const late = wins.filter(w=>w[0]>D*0.4).at(-1);
  out.motions[group] = { file: path.basename(e.File), durationSec: D, loop: m.Meta.Loop, fadeInSec: e.FadeInTime, fadeOutSec: e.FadeOutTime, curves: curves.map(c=>c.id), switches: m.Curves.filter(c=>/^Movement/.test(c.Id)).map(c=>c.Id), peakMotionSec: +(peak/30).toFixed(2), cutWindowsSec: wins, switchAtSec: switchAt, abortBeforeSec: m.Meta.Loop && !switchAt && curves.length && Math.max(...speed)<0.1 ? null : switchAt, chainFromSec: late ? late[0] : (m.Meta.Loop && !switchAt ? 0 : null), anytime: !switchAt && Math.max(...speed) < 0.1 };
}
console.log(JSON.stringify(out, null, 2));

// 配色设计方案生成器：定义 token -> 计算关键对比度，迭代到达标
function lum(hex){let c=hex.replace('#','');if(c.length===6){c=c.match(/.{2}/g).map(x=>parseInt(x,16)/255)}else{c=[0,0,0]}c=c.map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4));return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]}
function cr(a,b){let l1=lum(a),l2=lum(b);let hi=Math.max(l1,l2),lo=Math.min(l1,l2);return ((hi+0.05)/(lo+0.05))}
const hexToRgb=h=>h.replace('#','').match(/.{2}/g).map(x=>parseInt(x,16));
function mix(a,b,t){const A=hexToRgb(a),B=hexToRgb(b);return '#'+A.map((v,i)=>Math.round(v+(B[i]-v)*t).toString(16).padStart(2,'0')).join('')}

// 每套方案结构
// light / dark: { mp:主面板, sb:侧栏, sep:侧栏分隔, fg:前景文字, iconD, iconH, iconS,
//                s0..s4: surfaceContainer Lowest..Highest, onS, onSv, out, outV,
//                pri, onPri, priC, onPriC, sec, ter, card }
const schemes = {};

// ── 方案 A：暖白燕麦（延续现有暖色调，拉开明度层次） ──
schemes.A_warm_oat = {
  name: 'A · 暖白燕麦 Warm Oat',
  tag: '推荐 · 延续现暖色气质',
  light: {
    mp:'#F3EEE5', sb:'#E7E0D1', sep:'#C8BFA9', fg:'#24211B',
    iconD:'#6F685A', iconH:'#24211B', iconS:'#3D3830',
    s0:'#FFFFFF', s1:'#FBF8F1', s2:'#F3EEE5', s3:'#EAE3D3', s4:'#DFD6C2',
    onS:'#211E18', onSv:'#6C6555',
    out:'#C6BDA7', outV:'#D9D2C0',
    pri:'#9A6B2F', onPri:'#FFFFFF', priC:'#F2E6CF', onPriC:'#6C4A1C',
    sec:'#8A6A4E', ter:'#6F7A58', card:'#FFFFFF',
  },
  dark: {
    mp:'#0D0D0F', sb:'#17171A', sep:'#2F2F34', fg:'#E9E9EB',
    iconD:'#7E7E86', iconH:'#EDEDF0', iconS:'#B4B4BC',
    s0:'#0D0D0F', s1:'#141417', s2:'#1B1B1F', s3:'#232329', s4:'#2C2C33',
    onS:'#E9E9EB', onSv:'#9C9CA6',
    out:'#3A3A42', outV:'#303037',
    pri:'#C9A35E', onPri:'#1D1608', priC:'#2C2413', onPriC:'#E4C98F',
    sec:'#A88D6B', ter:'#93A07A', card:'#131316',
  }
};

// ── 方案 B：冷灰月白（中性冷调，苹果式克制） ──
schemes.B_cool_mist = {
  name: 'B · 冷灰月白 Cool Mist',
  tag: '中性冷调 · 苹果风',
  light: {
    mp:'#F4F6F8', sb:'#E9EDF1', sep:'#C6CDD6', fg:'#1B1F24',
    iconD:'#66707C', iconH:'#1B1F24', iconS:'#3A434E',
    s0:'#FFFFFF', s1:'#FBFCFD', s2:'#F4F6F8', s3:'#ECF0F4', s4:'#E1E6EC',
    onS:'#171B20', onSv:'#64707E',
    out:'#C2CAD4', outV:'#D6DDE5',
    pri:'#2E6FED', onPri:'#FFFFFF', priC:'#E4EDFC', onPriC:'#1B3F8A',
    sec:'#52627A', ter:'#3F7A76', card:'#FFFFFF',
  },
  dark: {
    mp:'#0E1013', sb:'#171A1F', sep:'#30353C', fg:'#E8EAEE',
    iconD:'#7E8894', iconH:'#EDF0F4', iconS:'#B3BCC8',
    s0:'#0E1013', s1:'#14171B', s2:'#1A1E23', s3:'#22262C', s4:'#2A2F36',
    onS:'#E8EAEE', onSv:'#9AA4B0',
    out:'#3A4048', outV:'#30353C',
    pri:'#6FA1F5', onPri:'#0A162E', priC:'#1A2B4A', onPriC:'#B9D2FA',
    sec:'#8B9BB4', ter:'#74A9A5', card:'#14181D',
  }
};

// ── 方案 C：纸白高对比（白纸黑字，靠描边+阴影分层） ──
schemes.C_paper = {
  name: 'C · 纸白高对比 Paper',
  tag: '黑白高对比 · 极简',
  light: {
    mp:'#FAFAFA', sb:'#F0F0F0', sep:'#CFCFCF', fg:'#111111',
    iconD:'#606060', iconH:'#111111', iconS:'#2E2E2E',
    s0:'#FFFFFF', s1:'#FCFCFC', s2:'#F7F7F7', s3:'#EFEFEF', s4:'#E4E4E4',
    onS:'#111111', onSv:'#5C5C5C',
    out:'#BDBDBD', outV:'#D6D6D6',
    pri:'#111111', onPri:'#FFFFFF', priC:'#EDEDED', onPriC:'#111111',
    sec:'#444444', ter:'#335C8E', card:'#FFFFFF',
  },
  dark: {
    mp:'#0A0A0C', sb:'#151517', sep:'#2D2D31', fg:'#EDEDEE',
    iconD:'#7C7C83', iconH:'#F0F0F2', iconS:'#B0B0B7',
    s0:'#0A0A0C', s1:'#111113', s2:'#171719', s3:'#1F1F22', s4:'#28282C',
    onS:'#EDEDEE', onSv:'#9A9AA2',
    out:'#38383D', outV:'#2E2E33',
    pri:'#FFFFFF', onPri:'#0A0A0C', priC:'#2A2A2E', onPriC:'#EDEDEE',
    sec:'#9A9AA2', ter:'#6E9FD6', card:'#101012',
  }
};

function check(name, s) {
  console.log('\n════════ ' + name + ' ════════');
  for (const mode of ['light','dark']) {
    const t = s[mode];
    console.log(`\n── ${mode === 'light' ? '浅色' : '暗色'} ──`);
    const L = mode === 'light' ? '浅' : '暗';
    const chk = (label, a, b, min, unit=':1') => {
      const v = cr(a,b);
      const ok = v >= min;
      console.log(`${ok ? '✓' : '✗'} ${label}: ${cr(a,b).toFixed(2)}${unit}${ok?'':'  <要求'+min+'!'}`);
      return v;
    };
    // 核心可区分性
    chk('侧栏 vs 主面板', t.sb, t.mp, mode==='light'?1.45:1.25);
    chk('卡片(s0) vs 主面板', t.s0, t.mp, mode==='light'?1.30:1.25);
    chk('最高surface vs 主面板', t.s4, t.mp, 1.45);
    // 相邻 surface 层级
    chk('s2 vs s3', t.s2, t.s3, 1.15);
    chk('s3 vs s4', t.s3, t.s4, 1.15);
    // 描边可见性
    chk('描边 vs 背景', t.out, t.mp, mode==='light'?2.2:1.8);
    // 文字
    chk('主文字 vs 背景', t.onS, t.mp, 10);
    chk('次级文字 vs 背景', t.onSv, t.mp, mode==='light'?4.5:4.5);
    chk('图标默认 vs 侧栏', t.iconD, t.sb, 4.5);
    chk('图标选中 vs 侧栏', t.iconS, t.sb, 4.5);
    // 强调
    chk('primary vs 主面板', t.pri, t.mp, mode==='light'?4.5:4.5);
    chk('primary容器文字 vs 容器', t.onPriC, t.priC, 4.5);
  }
}

for (const k of Object.keys(schemes)) check(schemes[k].name, schemes[k]);

// 导出为 JSON 供 HTML 预览器使用
const fs = require('fs');
fs.writeFileSync('E:/ws-project/Private-Agent/tmp/color_schemes.json', JSON.stringify(schemes, null, 2));
console.log('\n已导出 color_schemes.json');

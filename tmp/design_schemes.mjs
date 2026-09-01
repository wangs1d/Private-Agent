// V3：精调后的最终配色 + 相对亮度辅助
function lum(hex){let c=hex.replace('#','');if(c.length===6){c=c.match(/.{2}/g).map(x=>parseInt(x,16)/255)}else{c=[0,0,0]}c=c.map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4));return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]}
function cr(a,b){let l1=lum(a),l2=lum(b);let hi=Math.max(l1,l2),lo=Math.min(l1,l2);return ((hi+0.05)/(lo+0.05))}

const schemes = {};

// ── A 暖白燕麦：拉开层级，收敛暖橙 ──
schemes.A_warm_oat = {
  name: 'A · 暖白燕麦 Warm Oat',
  tag: '推荐 · 延续现暖色气质，层级拉满',
  light: {
    mp:'#F2EDE2', sb:'#E3DBC8', sep:'#BEB398', fg:'#26221B',
    iconD:'#635B49', iconH:'#242019', iconS:'#353022',
    s0:'#FFFFFF', s1:'#FAF7EF', s2:'#F2EDE2', s3:'#E7DFCB', s4:'#DAD0B5',
    onS:'#1F1C15', onSv:'#5E5746',
    out:'#AC9D7D', outV:'#CFC4A9',
    pri:'#A67C3E', onPri:'#FFFFFF', priC:'#F5EBD6', onPriC:'#6B4A1E',
    sec:'#8B6F4E', ter:'#6B7A4F', card:'#FFFFFF',
  },
  dark: {
    mp:'#0C0C0E', sb:'#1A1A1E', sep:'#333339', fg:'#EAEAEC',
    iconD:'#84848C', iconH:'#EFEFF2', iconS:'#BABAC2',
    s0:'#16161A', s1:'#19191D', s2:'#1F1F24', s3:'#28282E', s4:'#323239',
    onS:'#EAEAEC', onSv:'#9E9EA9',
    out:'#3E3E47', outV:'#313138',
    pri:'#A6A6AE', onPri:'#0C0C0E', priC:'#2E2E35', onPriC:'#D8D8DE',
    sec:'#9E9EA9', ter:'#8E8E98', card:'#151519',
  }
};

// ── B 冷灰月白：中性冷调 ──
schemes.B_cool_mist = {
  name: 'B · 冷灰月白 Cool Mist',
  tag: '中性冷调 · 苹果式克制',
  light: {
    mp:'#F2F4F7', sb:'#E4E9EF', sep:'#BDC6D1', fg:'#1B1F24',
    iconD:'#5C6673', iconH:'#171B20', iconS:'#363F4A',
    s0:'#FFFFFF', s1:'#FAFBFD', s2:'#F2F4F7', s3:'#E6EBF0', s4:'#D8DFE7',
    onS:'#13181D', onSv:'#596573',
    out:'#B3BDC9', outV:'#CFD6DE',
    pri:'#2E6FED', onPri:'#FFFFFF', priC:'#DFE9FB', onPriC:'#173B82',
    sec:'#52627A', ter:'#3F7A76', card:'#FFFFFF',
  },
  dark: {
    mp:'#0E1013', sb:'#191C21', sep:'#343940', fg:'#E9EBEF',
    iconD:'#848E9A', iconH:'#EFF2F6', iconS:'#B9C2CE',
    s0:'#0E1013', s1:'#16191E', s2:'#1D2126', s3:'#262B31', s4:'#2F343B',
    onS:'#E9EBEF', onSv:'#9DA7B3',
    out:'#3E444C', outV:'#32373E',
    pri:'#6FA1F5', onPri:'#0A162E', priC:'#1A2B4A', onPriC:'#B9D2FA',
    sec:'#8B9BB4', ter:'#74A9A5', card:'#161A1F',
  }
};

// ── C 纸白高对比：纯黑白，靠阴影分层 ──
schemes.C_paper = {
  name: 'C · 纸白高对比 Paper',
  tag: '黑白高对比 · 极简',
  light: {
    mp:'#F6F6F7', sb:'#FFFFFF', sep:'#E0E0E2', fg:'#111111',
    iconD:'#555555', iconH:'#111111', iconS:'#2A2A2A',
    s0:'#FFFFFF', s1:'#FCFCFC', s2:'#F5F5F6', s3:'#ECECEE', s4:'#E0E0E3',
    onS:'#111111', onSv:'#555555',
    out:'#B3B3B3', outV:'#D2D2D2',
    pri:'#111111', onPri:'#FFFFFF', priC:'#EDEDED', onPriC:'#111111',
    sec:'#444444', ter:'#0071E3', card:'#FFFFFF',
  },
  dark: {
    mp:'#0A0A0C', sb:'#171719', sep:'#303034', fg:'#EDEDEE',
    iconD:'#808087', iconH:'#F2F2F4', iconS:'#B4B4BB',
    s0:'#0A0A0C', s1:'#121214', s2:'#19191B', s3:'#212124', s4:'#2B2B2F',
    onS:'#EDEDEE', onSv:'#9E9EA6',
    out:'#3B3B40', outV:'#303035',
    pri:'#FFFFFF', onPri:'#0A0A0C', priC:'#2C2C30', onPriC:'#EDEDEE',
    sec:'#9E9EA6', ter:'#6E9FD6', card:'#121214',
  }
};

function check(name, s) {
  console.log('\n════════ ' + name + ' ════════');
  for (const mode of ['light','dark']) {
    const t = s[mode];
    let fails = 0;
    const chk = (label, a, b, min) => {
      const v = cr(a,b);
      const ok = v >= min;
      if(!ok) fails++;
      console.log(`${ok ? '✓' : '✗'} ${label}: ${v.toFixed(2)}:1${ok?'':'  <'+min}`);
    };
    console.log(`\n── ${mode === 'light' ? '浅色' : '暗色'} ──`);
    chk('侧栏 vs 主面板', t.sb, t.mp, 1.12);
    chk('卡片(s0) vs 主面板', t.s0, t.mp, 1.12);
    chk('最高surface vs 主面板', t.s4, t.mp, 1.25);
    chk('描边 vs 背景', t.out, t.mp, mode==='light'?2.0:1.6);
    chk('主文字 vs 背景', t.onS, t.mp, 10);
    chk('次级文字 vs 背景', t.onSv, t.mp, 4.5);
    chk('图标默认 vs 侧栏', t.iconD, t.sb, 4.5);
    chk('图标选中 vs 侧栏', t.iconS, t.sb, 4.5);
    chk('primary 文字对比', t.pri, t.mp, mode==='light'?4.5:4.0);
    chk('primary容器文字', t.onPriC, t.priC, 4.5);
    console.log(fails ? `  ⚠ ${fails} 项未达标` : '  ✔ 全部达标');
  }
}

for (const k of Object.keys(schemes)) check(schemes[k].name, schemes[k]);

const fs = await import('node:fs');
fs.writeFileSync('E:/ws-project/Private-Agent/tmp/color_schemes.json', JSON.stringify(schemes, null, 2));
console.log('\n已导出 color_schemes.json');

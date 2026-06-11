const fs = require('fs');
const c = fs.readFileSync('src/index.ts','utf8');
const re = /from\s+['"]([^'"]+)['"]/g;
let m;
while((m = re.exec(c))){ console.log(m[1]); }

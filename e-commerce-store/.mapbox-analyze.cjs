const fs = require('fs');
const s = fs.readFileSync('.mapbox-web.js', 'utf8');

function show(label, needle, before, after, from = 0) {
  const i = s.indexOf(needle, from);
  console.log('\n===' + label + '=== at', i);
  if (i >= 0) console.log(s.slice(Math.max(0, i - before), i + after));
  return i;
}

// All Di references
let pos = 0;
const hits = [];
while (pos < s.length) {
  const i = s.indexOf('Di(', pos);
  if (i === -1) break;
  hits.push(i);
  pos = i + 1;
}
console.log('Di( occurrences:', hits);
for (const h of hits) console.log('---', h, s.slice(h, h + 260));

show('var Di', 'var Di', 200, 600);
show('Di function', 'Di=function', 200, 600);
show(',Di=', ',Di=', 200, 600);
show(' Di=', ' Di=', 200, 600);

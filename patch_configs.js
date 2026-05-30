const fs = require('fs');
const paths = [
  '/Users/scottieryan/Library/Application Support/Canopy/isolated/agent-sterling/state/openclaw.json',
  '/Users/scottieryan/Library/Application Support/Canopy/isolated/agent-patch/state/openclaw.json'
];

paths.forEach(p => {
  if (fs.existsSync(p)) {
    let c = JSON.parse(fs.readFileSync(p, 'utf8'));
    c.gateway = c.gateway || {};
    c.gateway.mode = 'local';
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
    console.log(`Patched ${p}`);
  }
});

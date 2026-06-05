import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const newVersion = process.argv[2];
if (!newVersion) {
  console.error("Error: Please specify the version to bump to (e.g. node bump_version.js 0.2.0)");
  process.exit(1);
}

// Validate semver
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error("Error: Version must be in X.Y.Z format (e.g. 0.2.0)");
  process.exit(1);
}

const canopyDir = path.join(__dirname, '..');
const pkgPath = path.join(canopyDir, 'package.json');
const tauriConfPath = path.join(canopyDir, 'src-tauri/tauri.conf.json');
const adminPkgPath = path.join(canopyDir, '../canopy-admin/package.json');

// 1. Update package.json
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const oldVer = pkg.version;
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`[Success] Updated canopy/package.json: ${oldVer} -> ${newVersion}`);
} else {
  console.error("Error: Could not find canopy/package.json");
}

// 2. Update tauri.conf.json
if (fs.existsSync(tauriConfPath)) {
  const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
  const oldVer = conf.version;
  conf.version = newVersion;
  fs.writeFileSync(tauriConfPath, JSON.stringify(conf, null, 2) + '\n', 'utf8');
  console.log(`[Success] Updated canopy/src-tauri/tauri.conf.json: ${oldVer} -> ${newVersion}`);
} else {
  console.error("Error: Could not find canopy/src-tauri/tauri.conf.json");
}

// 3. Update canopy-admin/package.json (optional/best-effort)
if (fs.existsSync(adminPkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(adminPkgPath, 'utf8'));
  const oldVer = pkg.version;
  pkg.version = newVersion;
  fs.writeFileSync(adminPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`[Success] Updated canopy-admin/package.json: ${oldVer} -> ${newVersion}`);
}

/** Backseat packaging tests — static manifest/asset checks (no VS Code dependency). Run: npm test */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('activitybar container icon is an SVG that exists on disk', () => {
  const containers = pkg.contributes.viewsContainers.activitybar;
  assert.ok(Array.isArray(containers) && containers.length > 0, 'no activitybar containers');
  for (const c of containers) {
    // VS Code renders activitybar icons as a theme-colored mask: a PNG (or any
    // mostly-opaque raster) degrades to a solid square. Must be an SVG glyph
    // with a transparent background. Regression test for the solid-square bug.
    assert.match(c.icon, /\.svg$/, `container ${c.id} icon must be an SVG: ${c.icon}`);
    const p = path.join(root, c.icon);
    assert.ok(fs.existsSync(p), `container icon missing on disk: ${c.icon}`);
    const svg = fs.readFileSync(p, 'utf8');
    assert.match(svg, /<svg[\s>]/, 'not an SVG document');
    assert.match(svg, /viewBox="0 0 24 24"/, 'SVG should use a 24x24 viewBox');
  }
});

test('marketplace/extension icon exists on disk', () => {
  assert.ok(pkg.icon, 'package.json has no top-level icon');
  assert.ok(fs.existsSync(path.join(root, pkg.icon)), `marketplace icon missing: ${pkg.icon}`);
});

test('activitybar icon is not excluded from the VSIX', () => {
  // .vscodeignore must not filter out the container icon, or installs go
  // back to the solid square.
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  const containers = pkg.contributes.viewsContainers.activitybar;
  for (const c of containers) {
    const rel = c.icon.replace(/^\.\//, '');
    for (const line of ignore.split('\n')) {
      const pat = line.trim();
      if (!pat || pat.startsWith('#')) continue;
      // crude glob check: exact match or *.<ext> match
      if (pat === rel || (pat.startsWith('**/*') && rel.endsWith(pat.slice(4)))) {
        assert.fail(`.vscodeignore excludes the activitybar icon: ${pat}`);
      }
    }
  }
});

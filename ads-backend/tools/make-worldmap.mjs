// Builds /worldmap.json, the country outlines that report.html draws its map from.
// The page then needs nothing from outside: no map library and no map data from a CDN.
//
//   npm install world-atlas topojson-client d3-geo i18n-iso-countries
//   node make-worldmap.mjs ../../worldmap.json
//
// Output: { w, h, vb, c: [[ISO country code, name, SVG path], ...] } in a 960 x 500 box (Natural Earth projection);
// vb is the part of that box the map really covers (the box is cut to it so there is no empty space).
// Antarctica is left out. Three outlines have no ISO number in the source and are given the code of the
// country they are counted under in the apps' statistics: Northern Cyprus -> CY, Somaliland -> SO, Kosovo -> XK.
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { feature } = require('topojson-client');
const { geoNaturalEarth1, geoPath } = require('d3-geo');
const iso = require('i18n-iso-countries');
const topo = require('world-atlas/countries-110m.json');

const BY_NAME = { 'N. Cyprus': 'CY', 'Somaliland': 'SO', 'Kosovo': 'XK' };
const fc = feature(topo, topo.objects.countries);
const features = fc.features.filter(f => f.id !== '010');
const proj = geoNaturalEarth1().fitSize([960, 500], { type: 'FeatureCollection', features });
const path = geoPath(proj).digits(1);

const c = [];
const missing = [];
for (const f of features) {
  const cc = BY_NAME[f.properties.name] || (f.id ? iso.numericToAlpha2(String(f.id).padStart(3, '0')) : null);
  const d = path(f);
  if (!cc) { missing.push(f.properties.name); continue; }
  if (d) c.push([cc, f.properties.name, d]);
}
const out = process.argv[2] || 'worldmap.json';
const [[x0, y0], [x1, y1]] = path.bounds({ type: 'FeatureCollection', features });
const vb = [0, Math.floor(y0) - 4, 960, Math.ceil(y1 - y0) + 8];
fs.writeFileSync(out, JSON.stringify({ w: 960, h: 500, vb, c }));
console.log('countries:', c.length, '| size:', Math.round(fs.statSync(out).size / 1024), 'KB | without a code:', missing);

'use strict';
// Googleマップの店ID（ftid / !1s0x…:0x…）の前半は、おおよその位置を表すS2セルID。
// 数km程度の誤差はあるが、同名の別の店を取り違えないためのヒントとして使う。
function s2ToLatLng(hex) {
  let id;
  try { id = BigInt('0x' + String(hex).replace(/^0x/i, '')); } catch (e) { return null; }
  const face = Number(id >> 61n);
  if (face > 5) return null;
  const POS_TO_IJ = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]], POS_TO_ORI = [1, 0, 0, 3];
  let ori = face & 1, i = 0, j = 0;
  for (let k = 1; k <= 30; k++) {
    const pos = Number((id >> BigInt(2 * (30 - k) + 1)) & 3n);
    const ij = POS_TO_IJ[ori][pos];
    i = i * 2 + (ij >> 1); j = j * 2 + (ij & 1); ori ^= POS_TO_ORI[pos];
  }
  const st = v => (v + 0.5) / 2 ** 30, uv = s => (s >= 0.5 ? (4 * s * s - 1) / 3 : (1 - 4 * (1 - s) * (1 - s)) / 3);
  const u = uv(st(i)), v = uv(st(j));
  const f = [[1, u, v], [-u, 1, v], [-u, -v, 1], [-1, -v, -u], [v, -1, -u], [v, u, -1]][face];
  return { lat: Math.atan2(f[2], Math.hypot(f[0], f[1])) * 180 / Math.PI, lng: Math.atan2(f[1], f[0]) * 180 / Math.PI };
}
module.exports = { s2ToLatLng };

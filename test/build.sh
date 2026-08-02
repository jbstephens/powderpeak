#!/bin/bash
# Assemble the single self-contained index.html from source parts.
# three.min.js is inlined verbatim into its own <script> block.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$DIR/test/src"
OUT="$DIR/index.html"
{
  cat "$SRC/p1-head.html"
  printf '<script>\n'
  cat "$DIR/three.min.js"
  printf '\n</script>\n'
  cat "$SRC/p3-game-a.html" "$SRC/p3-game-b.html" "$SRC/p3-game-c.html" "$SRC/p3-game-d.html"
} > "$OUT"
echo "built $OUT ($(wc -c < "$OUT") bytes)"

# node --check every inline script block except the three.min.js one
node - "$OUT" <<'EOF'
const fs = require('fs'), cp = require('child_process'), os = require('os'), path = require('path');
const html = fs.readFileSync(process.argv[2], 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let checked = 0;
for (const b of blocks) {
  if (b.includes('three.js Authors') || b.length > 400000) continue; // vendored lib
  const f = path.join(os.tmpdir(), 'pp-check-' + (checked++) + '.js');
  fs.writeFileSync(f, b);
  const r = cp.spawnSync('node', ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('SYNTAX FAIL block', checked, '\n', r.stderr); process.exit(1); }
}
console.log('node --check passed on', checked, 'inline script block(s)');
EOF

// board/vendor/ 생성 스크립트 — Excalidraw + React 19를 로컬에 고정(vendoring)
//
// 왜 필요한가: 예전엔 esm.sh CDN에서 받아 썼는데, CDN이 한 번이라도 흔들리면
// 보드가 아예 안 열렸다(실제로 react-dom fetch 실패로 겪음). 저장소에 박아두면 그럴 일이 없다.
//
// 사용법 (Excalidraw 버전을 올리거나 vendor/ 를 다시 만들 때):
//   cd scripts
//   npm i @excalidraw/excalidraw@0.18.1 react@19.0.0 react-dom@19.0.0 esbuild
//   node build-vendor.mjs ../board/vendor
//   → board/vendor/ 를 통째로 새로 만든다. node_modules/ 는 커밋하지 않는다.
//
// 결과물(약 7MB): excalidraw.js + chunk-*.js + excalidraw.css + fonts/
// board/index.html 은 vendor/excalidraw.js 하나만 import 하고, React 도 그 안에서 꺼내 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.argv[2];
if (!OUT) { console.error('usage: node build-vendor.mjs <outDir>'); process.exit(1); }

const EX = path.join(HERE, 'node_modules/@excalidraw/excalidraw/dist/prod');
const rm = p => fs.rmSync(p, { recursive: true, force: true });
const mkd = p => fs.mkdirSync(p, { recursive: true });
const SRC = path.join(HERE, '.src');

rm(OUT); mkd(OUT); rm(SRC); mkd(SRC);

/* ───────────────── 1. 번들 ─────────────────
   npm이 배포하는 dist/prod 는 jotai·roughjs 등 20여 개를 bare import 로 남겨둔다
   (CDN이 대신 해결해 주던 부분). 그대로 두면 브라우저가 모듈을 못 찾고 죽으므로 직접 번들한다.

   React 를 external 로 빼면 안 된다 — 의존성 중 CJS 모듈이 런타임에 require("react") 를 하는데
   external ESM 은 require 로 못 불러서 "Dynamic require of react is not supported" 로 터진다.
   그래서 React 를 번들 안에 넣고, 보드 쪽에도 같은 인스턴스를 __React 로 내보낸다.
   (인스턴스가 둘이 되면 훅이 깨지므로 반드시 하나여야 한다.) */
const entry = path.join(SRC, 'entry.js');
fs.writeFileSync(entry, [
  'export * from "@excalidraw/excalidraw";',
  'export * as __React from "react";',
  'export * as __ReactDOMClient from "react-dom/client";',
].join('\n') + '\n');

// 54개 언어팩 중 쓰는 것만 남긴다(나머지는 빈 모듈). 지연 로딩이라 동작엔 영향 없고 1.4MB 절약.
const KEEP_LOCALES = ['en-', 'ko-KR-', 'percentages-'];
let stubbed = 0;
const trimLocales = {
  name: 'trim-locales',
  setup(b) {
    b.onLoad({ filter: /dist[/\\]prod[/\\]locales[/\\][^/\\]+\.js$/ }, args => {
      if (KEEP_LOCALES.some(k => path.basename(args.path).startsWith(k))) return null;
      stubbed++;
      return { contents: 'export default {};', loader: 'js' };
    });
  },
};

/* mermaid(+cytoscape+katex) 는 4MB 인데, 이걸 쓰는 건 "텍스트 → 다이어그램" 다이얼로그 하나뿐이고
   그 다이얼로그는 이 보드의 UI에서 열 수 있는 경로가 없다(햄버거 메뉴에도 없음). 그래서 제외한다.
   나중에 그 기능이 필요해지면 이 플러그인만 빼고 다시 빌드하면 된다. */
const dropMermaid = {
  name: 'drop-mermaid',
  setup(b) {
    b.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, () => ({ path: 'mermaid-stub', namespace: 'stub' }));
    b.onLoad({ filter: /^mermaid-stub$/, namespace: 'stub' }, () => ({
      contents: `const nope = () => { throw new Error('이 보드 빌드에는 mermaid 다이어그램 기능이 포함되어 있지 않습니다.'); };
export const parseMermaidToExcalidraw = nope;
export default { parseMermaidToExcalidraw: nope };`,
      loader: 'js',
    }));
  },
};

await esbuild.build({
  entryPoints: [entry],
  outdir: OUT,
  entryNames: 'excalidraw',
  chunkNames: 'chunk-[hash]',
  bundle: true, splitting: true, format: 'esm', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [trimLocales, dropMermaid],
  logLevel: 'error',
});
rm(SRC);
fs.copyFileSync(path.join(EX, 'index.css'), path.join(OUT, 'excalidraw.css'));

/* ── 회전 기능 제거 ──
   Excalidraw에는 회전을 끄는 옵션이 없다. 다행히 회전 핸들을 만드는 지점이 두 곳뿐이고
   렌더링과 클릭 판정이 같은 함수를 거치므로, "프레임일 때만 회전 핸들을 뺀다"를
   "항상 뺀다"로 바꾸면 핸들이 보이지도, 잡히지도 않는다.
   버전이 올라가 패턴이 안 맞으면 조용히 넘어가지 말고 빌드를 실패시킨다. */
const ROTATION_PATCHES = [
  { what: '단일 선택 회전 핸들',   // 원본: ke(e)&&(i={...i,rotation:!0})   ← ke = isFrameLikeElement
    re: /[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)&&\(([A-Za-z_$][\w$]*)=\{\.\.\.\1,rotation:!0\}\)/g,
    to: (_, o) => `(${o}={...${o},rotation:!0})` },
  { what: '다중 선택 회전 핸들',   // 원본: h?{...yf(u),rotation:!0}:yf(u)
    re: /[A-Za-z_$][\w$]*\?\{\.\.\.([A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)),rotation:!0\}:\1/g,
    to: (_, call) => `{...${call},rotation:!0}` },
];
for (const p of ROTATION_PATCHES) {
  let hits = 0;
  for (const f of fs.readdirSync(OUT).filter(f => f.endsWith('.js'))) {
    const fp = path.join(OUT, f);
    const src = fs.readFileSync(fp, 'utf8');
    const out = src.replace(p.re, (...a) => { hits++; return p.to(...a); });
    if (out !== src) fs.writeFileSync(fp, out);
  }
  if (hits !== 1) throw new Error(
    `회전 제거 패치 실패: "${p.what}" 패턴이 ${hits}번 잡힘(1이어야 함). ` +
    `Excalidraw 버전이 바뀌어 코드 모양이 달라졌을 수 있으니 패턴을 다시 확인할 것.`);
  console.log(`회전 제거: ${p.what} ✔`);
}

/* ───────────────── 2. 폰트 복사 ─────────────────
   폰트는 코드가 아니라 EXCALIDRAW_ASSET_PATH 기준 문자열 경로로 런타임에 받아가므로 그대로 복사한다.
   CJK 폴백 Xiaolai 는 209개 서브셋 12MB. 한글·라틴·기호 구간만 남기고 한자 전용 서브셋은 뺀다
   (그 글자들은 시스템 폰트로 대체 렌더될 뿐 깨지지 않는다). */
const chunkSrc = fs.readFileSync(path.join(EX, 'chunk-K2UTITRG.js'), 'utf8');
const varMap = {};
for (const m of chunkSrc.matchAll(/var ([A-Za-z_$][\w$]*)\s*=\s*"(\.\/fonts\/[^"]+\.woff2)"/g)) varMap[m[1]] = m[2];
const ranges = new Map();
for (const m of chunkSrc.matchAll(/\{uri:([A-Za-z_$][\w$]*),descriptors:\{unicodeRange:"([^"]*)"/g)) {
  if (varMap[m[1]]) ranges.set(varMap[m[1]].replace(/^\.\//, ''), m[2]);
}
// 순수 한자(CJK 통합 한자) 서브셋만 제외한다. 한글은 물론이고 「」・１２３ 같은
// CJK 문장부호·전각 문자도 한글 문서에 섞여 나오므로 반드시 남겨야 한다.
// (처음엔 "한글 구간만" 남겼다가 이 글자들이 404 나는 것을 테스트에서 잡았다.)
const HAN_ONLY = [[0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0x20000, 0x3FFFF]];
const wanted = r => r.split(',').some(seg => {
  const p = seg.replace('U+', '').split('-').map(h => parseInt(h, 16));
  const [a, b] = [p[0], p.length > 1 ? p[1] : p[0]];
  return !HAN_ONLY.some(([lo, hi]) => a >= lo && b <= hi);   // 한자 구간 밖이 조금이라도 있으면 남긴다
});

let dropped = 0, droppedBytes = 0;
(function copyFonts(src, rel) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const relPath = `${rel}/${e.name}`;
    if (e.isDirectory()) { copyFonts(from, relPath); continue; }
    if (relPath.startsWith('fonts/Xiaolai/')) {
      const r = ranges.get(relPath);
      if (!r || !wanted(r)) { dropped++; droppedBytes += fs.statSync(from).size; continue; }
    }
    const to = path.join(OUT, relPath);
    mkd(path.dirname(to));
    fs.copyFileSync(from, to);
  }
})(path.join(EX, 'fonts'), 'fonts');

const du = d => { let n = 0; (function w(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); e.isDirectory() ? w(f) : n += fs.statSync(f).size; } })(d); return n; };
console.log(`언어팩 ${stubbed}개 제외 (남김: ${KEEP_LOCALES.join(' ')})`);
console.log(`한자 전용 폰트 서브셋 ${dropped}개 제외 (${(droppedBytes / 1048576).toFixed(1)} MB)`);
console.log(`JS+CSS  ${((du(OUT) - du(path.join(OUT, 'fonts'))) / 1048576).toFixed(2)} MB`);
console.log(`fonts   ${(du(path.join(OUT, 'fonts')) / 1048576).toFixed(2)} MB`);
console.log(`TOTAL   ${(du(OUT) / 1048576).toFixed(2)} MB`);

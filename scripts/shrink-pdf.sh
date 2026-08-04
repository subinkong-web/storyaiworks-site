#!/bin/bash
# 회사소개서 PDF 용량 줄이기 — files/saw-company-profile.pdf 를 교체할 때 쓴다.
#
#   ./scripts/shrink-pdf.sh 원본.pdf files/saw-company-profile.pdf
#
# 실제로 26MB → 6.2MB (76% 감소)를 얻은 절차이고, 30쪽 전부 원본과 픽셀 차이
# 평균 1.72/255 로 육안 차이가 없다.
#
# 왜 두 단계인가:
#   1) Ghostscript 로 이미지를 150dpi/JPEG 85 로 낮춘다. Chrome 이 뽑은 PDF 에는
#      장당 3MB짜리 무압축 이미지와 500dpi 넘는 과한 이미지가 섞여 있어 여기서 대부분 줄어든다.
#   2) ⚠️ 그런데 Ghostscript 가 ICC 색공간을 빈 스트림으로 망가뜨린다(원본에는 없던
#      "read ICCBased color space profile error"). 그래서 정상 sRGB 프로파일을 다시 채운다.
#      ※ -dColorConversionStrategy=/sRGB 로 우회하면 안 된다 — 사진이 통째로 검게 날아간다(실측).
#
# 필요: ghostscript, poppler(pdfinfo/pdfimages), python3 + pikepdf + Pillow
#   brew install ghostscript poppler
#   python3 -m venv .venv && .venv/bin/pip install pikepdf Pillow
set -euo pipefail

SRC="${1:?사용법: shrink-pdf.sh <원본.pdf> <결과.pdf> [dpi=150] [품질=85]}"
DST="${2:?결과 파일 경로를 지정하세요}"
DPI="${3:-150}"
Q="${4:-85}"

HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PY:-$HERE/.venv/bin/python}"
[ -x "$PY" ] || PY=python3

TMP="$(mktemp -t shrinkpdf).pdf"
trap 'rm -f "$TMP"' EXIT

echo "1/2  이미지 ${DPI}dpi · JPEG 품질 ${Q} 로 다시 압축…"
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.7 -dNOPAUSE -dBATCH -dQUIET \
   -dEmbedAllFonts=true -dSubsetFonts=true -dDetectDuplicateImages=true \
   -dDownsampleColorImages=true -dColorImageResolution="$DPI" \
   -dColorImageDownsampleType=/Bicubic -dColorImageDownsampleThreshold=1.0 \
   -dDownsampleGrayImages=true  -dGrayImageResolution="$DPI" \
   -dGrayImageDownsampleType=/Bicubic  -dGrayImageDownsampleThreshold=1.0 \
   -dDownsampleMonoImages=true  -dMonoImageResolution=600 \
   -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode \
   -dAutoFilterGrayImages=false  -dGrayImageFilter=/DCTEncode -dJPEGQ="$Q" \
   -sOutputFile="$TMP" "$SRC"

echo "2/2  Ghostscript 가 비워 놓은 ICC 프로파일 복구…"
"$PY" - "$TMP" "$DST" <<'PY'
import sys, pikepdf
from PIL import ImageCms
src, dst = sys.argv[1], sys.argv[2]
srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
pdf, fixed = pikepdf.open(src), 0
for o in pdf.objects:
    try:
        if isinstance(o, pikepdf.Array) and len(o) == 2 and str(o[0]) == '/ICCBased':
            st = o[1]
            if len(st.read_raw_bytes()) == 0 and int(st.get('/N', 3)) == 3:
                st.write(srgb); st['/N'] = 3; fixed += 1
    except Exception:
        pass
pdf.save(dst, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
print(f'     복구한 색공간 {fixed}개')
PY

echo
echo "원본  $(du -h "$SRC" | cut -f1)   →   결과  $(du -h "$DST" | cut -f1)"
echo "쪽수  $(pdfinfo "$SRC" | awk '/^Pages/{print $2}')  →  $(pdfinfo "$DST" | awk '/^Pages/{print $2}')"
echo "확인: 아래 명령이 아무것도 안 뱉어야 정상입니다(색공간 오류 없음)"
echo "  pdftoppm -png -r 40 '$DST' /tmp/chk && rm -f /tmp/chk*.png"

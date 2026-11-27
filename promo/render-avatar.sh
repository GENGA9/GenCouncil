#!/bin/sh
# the avatar look's promo clips: phone (9:16) and desktop (16:9), in each screen language,
# then the README's copies: a GIF and smaller mp4s in docs/media/avatar
cd "$(dirname "$0")"
export REC_READY=".av-bust"
export REC_ORIGIN="${REC_ORIGIN:-http://localhost:5180}"
MEDIA=../docs/media/avatar
mkdir -p "$MEDIA"
for lang in ${LANGS:-ko en ja}; do
  REC_PATH="/vision-demo.html?avatar&film&lang=$lang" node record.mjs "avatar-9x16-$lang" 360 640 3 30 30 30 || exit 1
  REC_PATH="/vision-demo.html?avatar&film&lang=$lang" node record.mjs "avatar-16x9-$lang" 1280 720 1.5 30 30 30 || exit 1
  ffmpeg -y -loglevel error -i "avatar-9x16-$lang.mp4" -vf scale=720:-2 -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart "$MEDIA/avatar-9x16-$lang.mp4"
  ffmpeg -y -loglevel error -i "avatar-16x9-$lang.mp4" -vf scale=1280:-2 -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart "$MEDIA/avatar-16x9-$lang.mp4"
  ffmpeg -y -loglevel error -i "avatar-9x16-$lang.mp4" -vf "fps=10,scale=300:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$MEDIA/avatar-$lang.gif"
  rm -rf "frames-avatar-9x16-$lang" "frames-avatar-16x9-$lang" "chrome-avatar-9x16-$lang" "chrome-avatar-16x9-$lang"
done
ls -la "$MEDIA"/*.mp4 "$MEDIA"/*.gif

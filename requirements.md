vu-movie:
provide a complete new docker image/environment running on a synology nas ds918+. call the project and docker "vu-movie" for a proxy for movies and series to send to a specific movie URL to a video stream that can be played by vlc player and also an option to send it as an enigma2 bouquet to a vu+ duo2 box

main functionality:
via a webpage the user needs to input a URL of a movie or serie from a source movie site, or select the movie via a graphical gui. 
the application needs to scrap the video stream. this video stream will probably consists of several chunks. the application needs to redirect these video streams in 1 final video stream that should be able to be played directly with vlc.
use following GitHub code to scrape the URL: https://github.com/mesamirh/MovieBox-TUI

source movie sites:
https://overlook.cx/lobby
https://cinevo.nl
https://cinejoy.pk/
https://flixhub.studio/home
https://redflix.club/
https://www.1flex.org/
https://cinezo.st/

transcoding functionality:
video resolution should be preferable 1080p, but 720p is acceptable. in case of higher resolution from the original stream, the original stream should be transcode (decoding and encoding) by synology nas ds918+ making use of the hardware transcoding.
ffmpeg command for transcoding should look like:
ffmpeg -rw_timeout 10000000 -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 -fflags +genpts+discardcorrupt -err_detect ignore_err -init_hw_device vaapi=intel:/dev/dri/renderD128 -hwaccel vaapi -hwaccel_device intel -hwaccel_output_format vaapi -i <url> -vf scale_vaapi=w=1280:h=720:format=nv12,fps=25 -map 0:v:0 -map 0:a:0? -sn -dn -c:v h264_vaapi -b:v 1000k -maxrate 1200k -bufsize 1800k -profile:v high -level 4.1 -g 50 -r 25 -c:a aac -b:a 128k -ac 2 -ar 48000 -f mpegts -mpegts_flags +resend_headers pipe:1
where user must be able to select resolution (480p, 720p, 1080p), ratio (4:3, 16:9), audio bitrate, video bitrate. there should also be an option to always use transcoding, independent of the resolution of the original stream.
more information about ffmpeg can be found here: https://ffmpeg.org/ffmpeg.html

subtitle functionality:
when user has selected an URL, the application should search for a Dutch and/or English subtitle for this movie. subtitle should be in .srt format. possible sources needs to be entered by user. please check on internet if api's are available and how subtitles can be downloaded possible subtitle sources:
https://dl.opensubtitles.org/
https://www.justsubtitles.com/
https://www.addic7ed.com
https://www.opensubtitles.com/en/home
http://www.tvsubs.net/
http://www.tvsubtitles.net/

🐳 Docker Deployment (Synology DS918+)
Complete Dockerfile with Chromium, FFmpeg, and VAAPI support
docker-compose.yml with PostgreSQL and the app, passing /dev/dri for hardware transcoding
Optimized for Intel Celeron J3455 (Apollo Lake) with Intel HD Graphics 500
Add detailed logging and comments
avoid Docker build is failing because there's no package-lock.json in the project, generate it and fix the Dockerfile
make the DB connection lazy and provide a dummy URL during Docker build
Add database initialization so tables do exist during startup (need to create them on startup)
ensure the public dir always exists and fix the Dockerfile to handle missing dirs gracefully
provide proper info, warning, error messages through the complete code for backtracking and fault finding
fix the Dockerfile to handle the potentially missing public directory
ensure the public directory has content so it's always included in the Docker context


webpage:
- link/button to open the source video site
- a way to select the movie / movies and/or input field to input the flixer url of the movie / serie you want to see
- button to scrap the stream and convert it to a m3u Playlist, enigma2 bouquet
- button to search for subtitle in Dutch (Nederlands) and English
- button to transcode the stream first
- show the content/details of the stream (poster, description, title, etc.)
- button to download the stream
- possibility to enter subtitle sources
- setting to push subtitle file to satellite receiver (dreambox / vu+ duo2)

# Transcode oversized videos in-process with ffmpeg

WhatsApp silently drops inline-video deliveries above ~16 MB on
non-business accounts. POST /v1/post HEADs the source mediaUrl; when
it's over the cap, the bot now spawns ffmpeg in the container to
transcode the video down to a deliverable MP4 (≤720p, H.264, dynamic
bitrate sized to fit a 15 MB target, AAC audio at 96 kbps, faststart),
then sends the resulting buffer via Baileys.

We originally shipped a Cloudflare Stream integration for this (see
git history at d2cc154, reverted in 3283ce7). Stream worked
end-to-end but its pricing has a fixed $5/month subscription floor
regardless of usage — disproportionate for a personal bot that sends
oversized videos rarely. In-process ffmpeg trades that recurring cost
for: a ~12 MB ffmpeg binary in the Alpine image, transient ~200-300 MB
RAM during a transcode, and CPU contention on the shared-cpu-1x VM
while the encode runs. No external dependency, no per-video charges.

Bounded by a 120 s deadline (TranscodeTimeout → 504); ffmpeg/ffprobe
failures map to 502. The HEAD pre-flight stays as the trigger — if a
source host doesn't return content-length on HEAD we can't detect the
size in advance and fall through to the legacy send path, accepting
the silent-drop risk for that case. If the encoded VM consistently
OOM-kills on long source video we bump from 512 MB → 768 MB; the
choice between in-process and external-service transcoding doesn't
hinge on that bump.

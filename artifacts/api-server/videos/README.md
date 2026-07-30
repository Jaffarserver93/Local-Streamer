# Videos Folder

Place your video files here. Supported formats:
- `.mp4` (recommended — best compatibility with browsers and Smart TVs)
- `.mkv` (supported, but some TVs may not decode the audio codec)
- `.webm` (VP8/VP9 — good for Chrome-based TVs)

## Using a different folder

Set the `VIDEO_DIR` environment variable to point to any folder on your system:

```bash
# Android (via Termux or ADB)
VIDEO_DIR=/sdcard/Download node dist/index.mjs

# Linux — USB drive
VIDEO_DIR=/media/usb0/Movies node dist/index.mjs

# macOS — external drive
VIDEO_DIR=/Volumes/MyDrive/Videos node dist/index.mjs
```

## Testing

Drop any `.mp4` file here, then open the app in your browser.
The video should appear in the library and play with full seeking support.

#!/bin/bash
# Share the screener with anyone through a temporary public link (Cloudflare quick tunnel).
# The link works while this window stays open and the Mac is awake; it changes every time.
# Press Ctrl+C to stop sharing.
cd "$(dirname "$0")" || exit 1

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. Install it once with:"
  echo "    brew install cloudflared"
  exit 1
fi

if ! curl -s -o /dev/null http://127.0.0.1:8000/; then
  .venv/bin/python app.py &
  APP_PID=$!
  trap 'kill $APP_PID 2>/dev/null' EXIT
  sleep 4
fi

echo
echo "Starting the public link. Share the https://....trycloudflare.com address printed below."
echo
cloudflared tunnel --url http://127.0.0.1:8000

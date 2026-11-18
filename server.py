"""Local server: brokers SmallWebRTC offers to the bot and serves the built React client.

Dev: run this, plus `npm run dev` in client/ (Vite proxies /api here).
Prod-ish: `npm run build` in client/, then this serves client/dist at /.
"""

import argparse
from pathlib import Path

import uvicorn
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI
from fastapi.staticfiles import StaticFiles

load_dotenv(override=True)

from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection  # noqa: E402
from pipecat.transports.smallwebrtc.request_handler import (  # noqa: E402
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

from bot import run_bot  # noqa: E402

app = FastAPI()
handler = SmallWebRTCRequestHandler()


@app.post("/api/offer")
async def offer(request: SmallWebRTCRequest, background_tasks: BackgroundTasks):
    async def on_connection(connection: SmallWebRTCConnection):
        background_tasks.add_task(run_bot, connection, request.request_data)

    return await handler.handle_web_request(request=request, webrtc_connection_callback=on_connection)


@app.patch("/api/offer")
async def ice_candidate(request: SmallWebRTCPatchRequest):
    await handler.handle_patch_request(request)
    return {"status": "success"}


CLIENT_DIST = Path(__file__).parent / "client" / "dist"
if CLIENT_DIST.exists():
    # Mounted last so /api routes win
    app.mount("/", StaticFiles(directory=CLIENT_DIST, html=True), name="client")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=7860)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)

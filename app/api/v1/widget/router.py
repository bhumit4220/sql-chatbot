from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

router = APIRouter(tags=["widget"])

WIDGET_PATH = Path(__file__).resolve().parents[4] / "widget" / "dist" / "widget.js"


@router.get("/widget/widget.js")
async def serve_widget():
    return FileResponse(
        WIDGET_PATH,
        media_type="text/javascript",
        headers={"Cache-Control": "public, max-age=3600"},
    )

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.api.v1.router import router as v1_router
from app.api.v1.widget.router import router as widget_router
from app.core.exceptions import ChatbotException, chatbot_exception_handler
from app.core.logging import setup_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(debug=settings.debug)
    yield


app = FastAPI(title="SQL Chatbot", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

app.add_exception_handler(ChatbotException, chatbot_exception_handler)
app.include_router(v1_router)
app.include_router(widget_router)


@app.get("/health")
async def health():
    return {"status": "ok", "version": app.version}


@app.get("/ready")
async def ready():
    return {"status": "ready"}

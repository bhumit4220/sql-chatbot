#!/bin/bash
set -e

# Run migrations
alembic upgrade head

# Start server
exec gunicorn app.main:app \
    --worker-class uvicorn.workers.UvicornWorker \
    --workers ${WORKERS:-2} \
    --bind 0.0.0.0:8000 \
    --timeout 120

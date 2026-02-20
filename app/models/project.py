import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    udid: Mapped[str] = mapped_column(String(36), unique=True, index=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(255))
    connection_string_encrypted: Mapped[str] = mapped_column(Text)
    schema_cache: Mapped[str | None] = mapped_column(Text, nullable=True)
    schema_cached_at: Mapped[str | None] = mapped_column(nullable=True)
    schema_refresh_interval_hours: Mapped[int] = mapped_column(Integer, default=24)
    daily_token_limit: Mapped[int] = mapped_column(Integer, default=500_000)
    owner_admin_id: Mapped[int] = mapped_column(ForeignKey("admins.id"))

    # Auto-discovery fields
    autodiscovery_status: Mapped[str] = mapped_column(
        String(32), default="pending", server_default="pending"
    )
    autodiscovery_completed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    autodiscovery_doc_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )
    autodiscovery_batch_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    autodiscovery_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    autodiscovery_exclude_tables: Mapped[str | None] = mapped_column(Text, nullable=True)

    schema_documents = relationship(
        "SchemaDocument", back_populates="project", cascade="all, delete-orphan"
    )

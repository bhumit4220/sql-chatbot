"""add metadata_json to knowledge_entries

Revision ID: 3f22d6a332af
Revises: 7a7bd2be5487
Create Date: 2026-02-23 12:27:39.835870

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "3f22d6a332af"
down_revision: Union[str, None] = "7a7bd2be5487"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("knowledge_entries", sa.Column("metadata_json", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("knowledge_entries", "metadata_json")

"""add_autodiscovery_schema_documents

Revision ID: 7a7bd2be5487
Revises: bc7309ea4e44
Create Date: 2026-02-20 10:33:23.333191

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '7a7bd2be5487'
down_revision: Union[str, None] = 'bc7309ea4e44'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Enable pgvector extension
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # Create schema_documents table
    op.create_table('schema_documents',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('batch_id', sa.String(length=36), nullable=False),
        sa.Column('doc_type', sa.String(length=32), nullable=False),
        sa.Column('source_table', sa.String(length=128), nullable=True),
        sa.Column('source_column', sa.String(length=128), nullable=True),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('embedding', Vector(1536), nullable=False),
        sa.Column('metadata_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )

    # HNSW index for cosine similarity search
    op.execute(
        "CREATE INDEX ix_schema_documents_embedding ON schema_documents "
        "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
    )

    # Composite index for batch filtering
    op.create_index(
        'ix_schema_documents_project_batch',
        'schema_documents',
        ['project_id', 'batch_id']
    )

    # Composite index for project + doc_type lookups
    op.create_index(
        'ix_schema_documents_project_doctype',
        'schema_documents',
        ['project_id', 'doc_type']
    )

    # Add autodiscovery columns to projects
    op.add_column('projects', sa.Column('autodiscovery_status', sa.String(length=32), server_default='pending', nullable=False))
    op.add_column('projects', sa.Column('autodiscovery_completed_at', sa.DateTime(), nullable=True))
    op.add_column('projects', sa.Column('autodiscovery_doc_count', sa.Integer(), server_default='0', nullable=False))
    op.add_column('projects', sa.Column('autodiscovery_batch_id', sa.String(length=36), nullable=True))
    op.add_column('projects', sa.Column('autodiscovery_error', sa.Text(), nullable=True))
    op.add_column('projects', sa.Column('autodiscovery_exclude_tables', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('projects', 'autodiscovery_exclude_tables')
    op.drop_column('projects', 'autodiscovery_error')
    op.drop_column('projects', 'autodiscovery_batch_id')
    op.drop_column('projects', 'autodiscovery_doc_count')
    op.drop_column('projects', 'autodiscovery_completed_at')
    op.drop_column('projects', 'autodiscovery_status')
    op.drop_index('ix_schema_documents_project_doctype', table_name='schema_documents')
    op.drop_index('ix_schema_documents_project_batch', table_name='schema_documents')
    op.drop_index('ix_schema_documents_embedding', table_name='schema_documents')
    op.drop_table('schema_documents')
    op.execute("DROP EXTENSION IF EXISTS vector")

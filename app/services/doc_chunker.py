"""Document Chunker: converts rich schema + data samples into text documents for embedding."""

import logging
import re
from dataclasses import dataclass, field

from app.services.schema_inspector import RichSchema, TableInfo
from app.services.data_sampler import SamplerResult, ColumnSample

logger = logging.getLogger(__name__)

# Wide tables get split into chunks of this many columns
MAX_COLUMNS_PER_DOC = 100


@dataclass
class SchemaDoc:
    """A single text document ready for embedding."""

    doc_type: str  # "table", "enum_values", "relationship"
    source_table: str
    source_column: str | None = None
    content: str = ""
    metadata: dict = field(default_factory=dict)


class DocChunker:
    """Converts rich schema inspection + data samples into text documents."""

    def generate_documents(
        self, rich_schema: RichSchema, sampler_result: SamplerResult
    ) -> list[SchemaDoc]:
        """Generate all documents from schema and samples.

        Returns list of SchemaDoc ready for embedding.
        """
        docs: list[SchemaDoc] = []

        # 1. Table documents
        for table_name, table_info in sorted(rich_schema.tables.items()):
            docs.extend(self._make_table_docs(table_info))

        # 2. Enum/value documents
        docs.extend(self._make_enum_docs(sampler_result))

        # 3. Relationship documents (explicit FKs)
        docs.extend(self._make_explicit_relationship_docs(rich_schema))

        # 4. Relationship documents (inferred FKs)
        docs.extend(self._make_inferred_relationship_docs(rich_schema))

        logger.info(
            "Generated %d documents: %d table, %d enum_values, %d relationship",
            len(docs),
            sum(1 for d in docs if d.doc_type == "table"),
            sum(1 for d in docs if d.doc_type == "enum_values"),
            sum(1 for d in docs if d.doc_type == "relationship"),
        )
        return docs

    def _make_table_docs(self, table_info: TableInfo) -> list[SchemaDoc]:
        """Create one or more table documents (split wide tables)."""
        columns = table_info.columns
        chunks = []

        # Split wide tables
        for i in range(0, len(columns), MAX_COLUMNS_PER_DOC):
            chunk = columns[i : i + MAX_COLUMNS_PER_DOC]
            part = i // MAX_COLUMNS_PER_DOC + 1
            total_parts = (len(columns) + MAX_COLUMNS_PER_DOC - 1) // MAX_COLUMNS_PER_DOC

            lines = []
            if total_parts > 1:
                lines.append(f"Table: {table_info.name} (part {part}/{total_parts})")
            else:
                lines.append(f"Table: {table_info.name}")

            if table_info.comment:
                lines.append(f"Description: {table_info.comment}")

            lines.append("Columns:")
            for col in chunk:
                parts_list = [col.type]
                if col.is_pk:
                    parts_list.append("PK")
                if not col.nullable:
                    parts_list.append("not null")
                if col.default:
                    parts_list.append(f"default: {col.default}")
                if col.comment:
                    parts_list.append(col.comment)
                annotation = ", ".join(parts_list)
                lines.append(f"  - {col.name} ({annotation})")

            if table_info.primary_key:
                lines.append(f"Primary Key: {', '.join(table_info.primary_key)}")

            # Unique indexes
            unique_indexes = [idx for idx in table_info.indexes if idx.unique]
            if unique_indexes:
                for idx in unique_indexes:
                    cols = ", ".join(idx.columns)
                    lines.append(f"Unique Index: {idx.name} ({cols})")

            content = "\n".join(lines)
            chunks.append(
                SchemaDoc(
                    doc_type="table",
                    source_table=table_info.name,
                    content=content,
                    metadata={
                        "column_count": len(chunk),
                        "part": part if total_parts > 1 else None,
                    },
                )
            )

        return chunks

    def _make_enum_docs(self, sampler_result: SamplerResult) -> list[SchemaDoc]:
        """Create enum_values documents from sampled columns."""
        docs = []
        for sample in sampler_result.samples:
            if sample.skipped_reason == "timeout":
                continue

            lines = [f"Table: {sample.table}, Column: {sample.column} ({sample.column_type})"]

            if sample.skipped_reason == "high_cardinality":
                lines.append(
                    f"This column has {sample.distinct_count} distinct values "
                    f"(high cardinality — not an enum)."
                )
            elif sample.skipped_reason == "pii":
                lines.append(
                    f"This column has {sample.distinct_count} distinct values "
                    f"(PII column — values not sampled)."
                )
            elif sample.values:
                if sample.distinct_count <= 20:
                    lines.append(
                        f"This column has {sample.distinct_count} distinct values "
                        f"(likely an enum/status field)."
                    )
                else:
                    lines.append(
                        f"This column has {sample.distinct_count} distinct values."
                    )
                lines.append("Value distribution:")
                for i, v in enumerate(sample.values):
                    val_str = v["val"] if v["val"] is not None else "NULL"
                    suffix = " (most common)" if i == 0 else ""
                    lines.append(f"  {val_str} = {v['cnt']:,} rows{suffix}")
            else:
                continue

            docs.append(
                SchemaDoc(
                    doc_type="enum_values",
                    source_table=sample.table,
                    source_column=sample.column,
                    content="\n".join(lines),
                    metadata={"distinct_count": sample.distinct_count},
                )
            )

        return docs

    def _make_explicit_relationship_docs(self, rich_schema: RichSchema) -> list[SchemaDoc]:
        """Create relationship documents from explicit foreign keys."""
        docs = []
        for table_name, table_info in sorted(rich_schema.tables.items()):
            for fk in table_info.foreign_keys:
                src_cols = ", ".join(fk.constrained_columns)
                ref_cols = ", ".join(fk.referred_columns)

                lines = [
                    f"Foreign Key: {table_name}.{src_cols} → {fk.referred_table}.{ref_cols}",
                    f'The "{src_cols}" column in "{table_name}" references '
                    f'the primary key "{ref_cols}" in "{fk.referred_table}".',
                ]

                # Generate a natural description
                if len(fk.constrained_columns) == 1:
                    lines.append(
                        f"Each {_singularize(table_name)} is associated with "
                        f"one {_singularize(fk.referred_table)}."
                    )

                docs.append(
                    SchemaDoc(
                        doc_type="relationship",
                        source_table=table_name,
                        source_column=fk.constrained_columns[0] if fk.constrained_columns else None,
                        content="\n".join(lines),
                        metadata={
                            "fk_type": "explicit",
                            "referred_table": fk.referred_table,
                        },
                    )
                )

        return docs

    def _make_inferred_relationship_docs(self, rich_schema: RichSchema) -> list[SchemaDoc]:
        """Create relationship documents from naming convention (inferred FKs).

        Rules:
        - Column named exactly {singular_table_name}_id
        - A table named {plural} must exist
        - That table must have an 'id' column
        - No explicit FK already exists for this column
        - No prefix before the table name (e.g. 'old_contractor_id' excluded)
        """
        docs = []
        # Build set of existing explicit FKs for quick lookup
        explicit_fks: set[tuple[str, str]] = set()
        for table_name, table_info in rich_schema.tables.items():
            for fk in table_info.foreign_keys:
                for col in fk.constrained_columns:
                    explicit_fks.add((table_name, col))

        # Build table name → has 'id' column lookup
        tables_with_id = set()
        for table_name, table_info in rich_schema.tables.items():
            if any(c.name == "id" for c in table_info.columns):
                tables_with_id.add(table_name)

        for table_name, table_info in sorted(rich_schema.tables.items()):
            for col in table_info.columns:
                if not col.name.endswith("_id"):
                    continue
                if col.name == "id":
                    continue
                if (table_name, col.name) in explicit_fks:
                    continue

                # Extract potential table name: column "contractor_id" → "contractor"
                stem = col.name[:-3]  # remove "_id"
                if not stem:
                    continue

                # Must be exactly {singular}_id — no prefix allowed
                # Check: stem should not contain underscores that would indicate a prefix
                # Actually, some valid cases like "job_type_id" → "job_types" exist
                # The rule is: column must be named exactly {singular_table_name}_id
                # So we try both stem and stem + 's' / stem + 'es' / stem + 'ies'
                candidates = _pluralize_candidates(stem)

                matched_table = None
                for candidate in candidates:
                    if candidate in rich_schema.tables and candidate in tables_with_id:
                        matched_table = candidate
                        break

                if not matched_table:
                    continue

                # Verify no prefix: the column name should be exactly singular_id
                # e.g., "contractor_id" is OK but "old_contractor_id" is not
                singular = _singularize(matched_table)
                expected_col = f"{singular}_id"
                if col.name != expected_col:
                    continue

                lines = [
                    f"Inferred Relationship: {table_name}.{col.name} → {matched_table}.id",
                    f'The "{col.name}" column in "{table_name}" likely references '
                    f'the primary key "id" in "{matched_table}" (based on naming convention).',
                    f"Each {_singularize(table_name)} is associated with "
                    f"one {_singularize(matched_table)}.",
                ]

                docs.append(
                    SchemaDoc(
                        doc_type="relationship",
                        source_table=table_name,
                        source_column=col.name,
                        content="\n".join(lines),
                        metadata={
                            "fk_type": "inferred",
                            "referred_table": matched_table,
                        },
                    )
                )

        return docs


def _singularize(name: str) -> str:
    """Simple English singularization for table names."""
    if name.endswith("ies"):
        return name[:-3] + "y"
    if name.endswith("ses") or name.endswith("xes") or name.endswith("zes"):
        return name[:-2]
    if name.endswith("s") and not name.endswith("ss"):
        return name[:-1]
    return name


def _pluralize_candidates(singular: str) -> list[str]:
    """Return possible plural forms of a singular noun."""
    candidates = []
    # Regular: contractor → contractors
    candidates.append(singular + "s")
    # -y → -ies: category → categories
    if singular.endswith("y"):
        candidates.append(singular[:-1] + "ies")
    # -s/-x/-z → -es: status → statuses
    if singular.endswith(("s", "x", "z")):
        candidates.append(singular + "es")
    # Already plural or same form
    candidates.append(singular)
    return candidates

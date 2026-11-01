"""Independent specification folders, preserving all existing folder and revision IDs."""

import sqlalchemy as sa
from alembic import op

revision = "0003_specification_folders"
down_revision = "0002_catalog"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("folders", sa.Column("kind", sa.String(30), nullable=False, server_default="use_cases"))
    op.create_check_constraint("ck_folders_kind", "folders", "kind IN ('use_cases', 'specifications')")
    op.create_index("ix_folders_project_kind_parent", "folders", ["project_id", "kind", "parent_id"])
    op.add_column("specifications", sa.Column("folder_id", sa.String(36), nullable=True))
    op.create_foreign_key("fk_specifications_folder", "specifications", "folders", ["folder_id"], ["id"])
    op.create_index("ix_specifications_folder_id", "specifications", ["folder_id"])


def downgrade():
    op.drop_index("ix_specifications_folder_id", table_name="specifications")
    op.drop_constraint("fk_specifications_folder", "specifications", type_="foreignkey")
    op.drop_column("specifications", "folder_id")
    # A downgrade cannot reinterpret specification folders as case folders.
    op.execute("DELETE FROM folders WHERE kind='specifications'")
    op.drop_index("ix_folders_project_kind_parent", table_name="folders")
    op.drop_constraint("ck_folders_kind", "folders", type_="check")
    op.drop_column("folders", "kind")

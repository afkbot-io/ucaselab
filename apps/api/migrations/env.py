from alembic import context
from app import models  # noqa: F401
from app.db import Base, engine

context.configure(connection=engine.connect(), target_metadata=Base.metadata, compare_type=True)
with context.begin_transaction():
    context.run_migrations()

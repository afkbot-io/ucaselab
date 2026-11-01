"""Shared bounded catalog queries and independent, project-local label dictionaries."""

import unicodedata
from typing import Annotated, Literal

from pydantic import Field
from sqlalchemy import Text, cast, func, or_, select

from . import models as m
from .security import fail

Limit = Annotated[int, Field(ge=1, le=1000)]
Offset = Annotated[int, Field(ge=0)]
Search = Annotated[str, Field(max_length=500)]
LabelScope = Literal["use_cases", "specifications", "platforms"]
Sort = Literal["title", "title_desc", "created", "created_desc"]


def text_filter(query, search, *columns):
    # Treat SQL wildcard characters as text; every word must match a visible field.
    for word in search.strip().split():
        pattern = "%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.where(or_(*(cast(c, Text).ilike(pattern, escape="\\") for c in columns)))
    return query


def order_query(query, model, sort, title=None):
    title = title if title is not None else getattr(model, "title", getattr(model, "name", model.id))
    column = func.lower(title) if sort.startswith("title") else model.created_at
    return query.order_by(column.desc() if sort.endswith("_desc") else column.asc(), model.id)


def page(ctx, query, serialize, limit=500, offset=0):
    total = ctx.db.scalar(select(func.count()).select_from(query.order_by(None).subquery()))
    values = ctx.db.scalars(query.limit(limit).offset(offset)).all()
    return {
        "items": [serialize(v) for v in values],
        "total": total,
        "next_offset": offset + limit if offset + limit < total else None,
    }


def clean_label(value):
    return " ".join(unicodedata.normalize("NFKC", value).split())


def remember_labels(ctx, values, scope):
    if len(values) > (20 if scope == "platforms" else 30):
        fail("TOO_MANY_LABELS", "Выберите до 30 тегов или до 20 платформ")
    known = {
        o.normalized: o
        for o in ctx.db.scalars(
            select(m.ProjectLabel).where(
                m.ProjectLabel.project_id == ctx.project_id, m.ProjectLabel.scope == scope
            )
        )
    }
    defaults = {v.casefold(): v for v in ("Web", "iOS", "Android", "API", "Desktop")}
    result, seen = [], set()
    for raw in values:
        value = clean_label(raw)
        if not value or len(value) > 80:
            fail("INVALID_LABEL", "Тег или платформа: от 1 до 80 символов")
        key = value.casefold()
        if key in seen:
            continue
        seen.add(key)
        if key in known:
            value = known[key].value
        elif scope == "platforms":
            value = defaults.get(key, value)
        if key not in known:
            obj = m.ProjectLabel(project_id=ctx.project_id, scope=scope, normalized=key, value=value)
            ctx.db.add(obj)
            known[key] = obj
        result.append(value)
    return result

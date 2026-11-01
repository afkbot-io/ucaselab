import csv
import io
import json
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape


def report_rows(report):
    for run in report["snapshot"]["runs"]:
        for item in run["items"]:
            attempt = item["attempts"][-1]
            variant = item["snapshot"].get("variant")
            yield {
                "run": run["title"],
                "key": item["snapshot"]["key"],
                "title": item["snapshot"]["content"]["title"],
                "publication": item["snapshot"]["publication_number"],
                "case_source": run.get("case_source", "published"),
                "revision_id": item["revision_id"],
                "revision_number": item["snapshot"].get("revision_number"),
                "variant": variant["name"] if variant else "Основной сценарий",
                "status": attempt["status"],
                "attempt": attempt["attempt"],
                "actual_result": attempt["actual_result"],
                "actor_id": attempt["actor_id"] or "",
                "actor_name": attempt.get("actor_name") or attempt["actor_id"] or "Не указан",
                "finished_at": attempt.get("finished_at") or "",
                "evidence": "; ".join(
                    a["filename"] + " (SHA-256 " + a["sha256"] + ")" for a in attempt.get("attachments", [])
                ),
                "environment": run["environment"].get("name", ""),
                "base_url": run["environment"].get("base_url", ""),
                "build": run["build"],
                "readiness_environment": run.get("readiness", {}).get("checks", {}).get("environment", ""),
                "readiness_accounts": run.get("readiness", {}).get("checks", {}).get("accounts", ""),
                "readiness_dependencies": run.get("readiness", {}).get("checks", {}).get("dependencies", ""),
                "readiness_notes": run.get("readiness", {}).get("notes", ""),
                "allow_partial": run.get("readiness", {}).get("allow_partial", False),
            }


def render_report(report, format):
    if format == "json":
        return json.dumps(report, ensure_ascii=False, indent=2).encode(), "application/json"
    if format == "csv":
        output = io.StringIO()
        writer = csv.DictWriter(
            output,
            fieldnames=[
                "run",
                "key",
                "title",
                "publication",
                "case_source",
                "revision_id",
                "revision_number",
                "variant",
                "status",
                "attempt",
                "actual_result",
                "actor_id",
                "actor_name",
                "finished_at",
                "evidence",
                "environment",
                "base_url",
                "build",
                "readiness_environment",
                "readiness_accounts",
                "readiness_dependencies",
                "readiness_notes",
                "allow_partial",
            ],
        )
        writer.writeheader()
        for row in report_rows(report):
            # Prevent spreadsheet formula execution in user-supplied strings.
            writer.writerow(
                {
                    k: "'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@", "\t", "\r")) else v
                    for k, v in row.items()
                }
            )
        return ("\ufeff" + output.getvalue()).encode(), "text/csv; charset=utf-8"
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    font_path = Path(__file__).parent / "fonts/DejaVuSans.ttf"
    pdfmetrics.registerFont(TTFont("Report", str(font_path)))
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            "ReportBody",
            fontName="Report",
            fontSize=9,
            leading=14,
            spaceAfter=8,
            textColor=colors.HexColor("#18233B"),
        )
    )
    styles.add(
        ParagraphStyle("ReportTitle", parent=styles["ReportBody"], fontSize=22, leading=28, spaceAfter=18)
    )
    styles.add(
        ParagraphStyle("ReportHeading", parent=styles["ReportBody"], fontSize=13, leading=19, spaceBefore=14)
    )

    def p(text, style="ReportBody"):
        return Paragraph(escape(str(text)).replace("\n", "<br/>"), styles[style])

    pdf_output = io.BytesIO()
    document = SimpleDocTemplate(
        pdf_output,
        pagesize=A4,
        leftMargin=42,
        rightMargin=42,
        topMargin=42,
        bottomMargin=42,
        title=report["title"],
        author="UCaseLab",
    )
    labels = {
        "queued": "Ожидает",
        "running": "Выполняется",
        "completed": "Завершён",
        "passed": "Успешно",
        "failed": "Ошибка приложения",
        "scenario_issue": "Неточность сценария",
        "blocked": "Не удалось проверить",
        "skipped": "Пропущено",
        "cancelled": "Отменено",
        "draft": "Подготовлен",
    }

    def readable_date(value):
        return datetime.fromisoformat(value).strftime("%d.%m.%Y %H:%M UTC") if value else "Не указано"

    methodology = (
        report["snapshot"]["methodology"]
        .replace("passed", "успешно")
        .replace("failed", "не пройдено")
        .replace("selected", "выбрано")
        .replace("scenario_issue", "неточность сценария")
        .replace("blocked", "не удалось проверить")
    )
    story = [
        p("UCASELAB · ОТЧЁТ", "ReportHeading"),
        p(report["title"], "ReportTitle"),
        p(report["snapshot"]["project"]["name"]),
        p("Промежуточный снимок" if report["interim"] else "Итоговый снимок"),
        p(readable_date(report["snapshot"]["generated_at"])),
        p(methodology),
    ]
    for run in report["snapshot"]["runs"]:
        summary = run["summary"]
        counts = summary["counts"]
        story.extend(
            [
                p(run["title"], "ReportHeading"),
                p(
                    f"Состояние: {labels.get(run['status'], run['status'])} · Сборка: {run['build'] or 'не указана'} · Выбрано: {summary['selected']}"
                ),
                p(" · ".join(f"{labels.get(k, k)}: {v}" for k, v in counts.items() if v)),
            ]
        )
        preparation = run.get("readiness", {})
        story.append(p("Стенд: " + run["environment"].get("base_url", "не указан")))
        if preparation.get("checked_at"):
            state_labels = {
                "ready": "подтверждено",
                "blocked": "есть препятствие",
                "not_checked": "не проверено",
                "not_required": "не требуется",
            }
            names = {"environment": "Стенд", "accounts": "Аккаунты", "dependencies": "Почта и инструменты"}
            story.append(
                p(
                    " · ".join(
                        names[key] + ": " + state_labels[value]
                        for key, value in preparation.get("checks", {}).items()
                    )
                )
            )
            if preparation.get("allow_partial"):
                story.append(p("Запуск с ограничениями"))
            if preparation.get("notes"):
                story.append(p(preparation["notes"]))
    for row in report_rows(report):
        story.extend(
            [
                p(
                    f"{row['key']} · "
                    + (
                        f"Черновик r{row['revision_number']}"
                        if row["case_source"] == "draft"
                        else f"v{row['publication']}"
                    )
                    + f" · {row['title']}",
                    "ReportHeading",
                ),
                p(
                    f"{row['variant']} · {labels.get(row['status'], row['status'])} · Попытка {row['attempt']}"
                ),
                p(row["actual_result"] or "Фактический результат не записан"),
                p("Исполнитель: " + row["actor_name"] + " · " + readable_date(row["finished_at"])),
                *([p("Доказательства: " + row["evidence"])] if row["evidence"] else []),
            ]
        )
    story.extend([Spacer(1, 18), p("SHA-256 снимка: " + report["content_hash"])])

    def footer(canvas, doc):
        canvas.setFont("Report", 8)
        canvas.setFillColor(colors.HexColor("#69758B"))
        canvas.drawString(42, 24, "UCaseLab · " + str(doc.page))

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return pdf_output.getvalue(), "application/pdf"

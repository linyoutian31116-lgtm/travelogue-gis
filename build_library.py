# -*- coding: utf-8 -*-
"""Build the bundled multi-text project library from the three source DOCX files.

The Yuexi and Qianyou records reuse the researched place dictionaries and route
event lists that produced the earlier reviewed maps.  The Zhejiang project keeps
the reviewed workbook conversion as its authority and only restores the complete
DOCX source text plus the common v3 fields used by the website.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent
WORK = WORKSPACE / "work"
sys.path[:0] = [str(ROOT), str(WORK)]

import app  # noqa: E402
import build_qianyou1_workbook as qianyou  # noqa: E402
import build_yuexi4_workbook as yuexi  # noqa: E402


DEFAULT_DOCS = {
    "qianyou1": Path(r"C:\Users\yarin\OneDrive\Documents\黔游日记一.docx"),
    "yuexi4": Path(r"C:\Users\yarin\OneDrive\Documents\粵西游記4.docx"),
    "zheyou": Path(r"C:\Users\yarin\OneDrive\Documents\徐霞客游记_浙游日记(上海古籍出版社).docx"),
}


def clean(value: Any) -> str:
    return str(value or "").strip()


def source_text(path: Path) -> str:
    return app.extract_docx_text(path.read_bytes()).strip()


def source_signature(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def relative_candidate(latitude: float, longitude: float, bearing: float, li: float) -> dict[str, float]:
    """Project a gazetteer relation without treating it as an exact coordinate."""
    radius_km = 6371.0088
    distance_km = li * 0.576
    angular = distance_km / radius_km
    lat1 = math.radians(latitude)
    lon1 = math.radians(longitude)
    theta = math.radians(bearing)
    lat2 = math.asin(math.sin(lat1) * math.cos(angular) + math.cos(lat1) * math.sin(angular) * math.cos(theta))
    lon2 = lon1 + math.atan2(
        math.sin(theta) * math.sin(angular) * math.cos(lat1),
        math.cos(angular) - math.sin(lat1) * math.sin(lat2),
    )
    return {"latitude": round(math.degrees(lat2), 7), "longitude": round(math.degrees(lon2), 7)}


def apply_shidian_evidence(project: dict[str, Any], evidence_paths: list[Path]) -> int:
    """Attach reviewed Shidian evidence; never overwrite an accepted coordinate."""
    by_name: dict[str, list[dict[str, Any]]] = {}
    for path in evidence_paths:
        if not path.exists():
            continue
        records = json.loads(path.read_text(encoding="utf-8"))
        for record in records if isinstance(records, list) else records.get("records", []):
            by_name.setdefault(clean(record.get("name")), []).append(record)

    applied = 0
    computable = {"可試算", "可試算候選", "原文試算"}
    for item in project.get("mentions", []):
        records = by_name.get(clean(item.get("normalizedName")), [])
        if not records:
            continue
        item["gazetteerEvidence"] = []
        for record in records:
            independent = "徐霞客" not in clean(record.get("book")) and "霞客" not in clean(record.get("book"))
            evidence = {
                "provider": "識典古籍",
                "evidenceType": clean(record.get("evidenceType")) or (
                    "gazetteer" if independent else "travelogue_transcription"
                ),
                "book": clean(record.get("book")),
                "quote": clean(record.get("evidence")),
                "url": clean(record.get("url")),
                "jurisdiction": clean(record.get("jurisdiction")),
                "match": clean(record.get("match")),
                "direction": clean(record.get("direction")),
                "bearing": record.get("bearing"),
                "li": record.get("li"),
                "meters": float(record["li"]) * 576 if isinstance(record.get("li"), (int, float)) else None,
                "base": clean(record.get("base")),
                "baseLatitude": record.get("baseLat"),
                "baseLongitude": record.get("baseLon"),
                "conclusion": clean(record.get("decision")),
                "confidence": clean(record.get("confidence")),
                "reason": clean(record.get("reason")),
                "checkedAt": "2026-08-19",
            }
            if (
                evidence["conclusion"] in computable
                and isinstance(evidence["baseLatitude"], (int, float))
                and isinstance(evidence["baseLongitude"], (int, float))
                and isinstance(evidence["bearing"], (int, float))
                and isinstance(evidence["li"], (int, float))
            ):
                candidate = relative_candidate(
                    float(evidence["baseLatitude"]), float(evidence["baseLongitude"]),
                    float(evidence["bearing"]), float(evidence["li"]),
                )
                candidate.update(
                    {
                        "method": "地方志基準點＋八方位角＋里數換算",
                        "liMeters": 576,
                        "uncertainty": "方向至少按 ±22.5°；里數及歷史道路曲折另有不確定性",
                        "status": "candidate_only",
                    }
                )
                evidence["candidateCoordinate"] = candidate
            item["gazetteerEvidence"].append(evidence)
            applied += 1
        item["gazetteerReviewStatus"] = "reviewed"
        item["coordinateReviewRequired"] = True
        item["coordinateDecision"] = None
        item["reviewRequired"] = True
    if applied:
        project.setdefault("researchSources", []).append(
            {"name": "識典古籍", "role": f"地方志交叉查證（已寫入 {applied} 條證據，不覆寫 CHGIS／OSM 坐標）"}
        )
    return applied


def location_status(value: Any) -> str:
    text = clean(value)
    if text == "可定位":
        return "locatable"
    if "區域" in text or "区域" in text or "推定" in text:
        return "regional"
    if "相對" in text or "相对" in text:
        return "relative"
    if "無法" in text or "无法" in text:
        return "unlocatable"
    return "unverified"


def gis_decision(value: Any) -> str:
    text = clean(value)
    if text in {"收錄", "保留"}:
        return "keep"
    if text in {"不收錄", "不保留", "排除"}:
        return "discard"
    return "review"


def admin_level(place: dict[str, Any], name: str = "") -> str:
    level = clean(place.get("記錄層級"))
    kind = clean(place.get("地名類型"))
    label = f"{name} {level} {kind}"
    if "府級" in label or "府城" in label or name.endswith("府"):
        return "prefecture"
    if "縣級" in label or "县级" in label or "縣城" in label or "县城" in label or name.endswith(("縣", "县")):
        return "county"
    return "other"


def movement_type(status: str) -> str:
    if "遊覽" in status:
        return "visited"
    if any(token in status for token in ("停宿", "停留", "停泊", "停歇", "用餐", "飲泉", "返回")):
        return "stayed"
    if "抵達" in status or "到達" in status:
        return "reached"
    if any(token in status for token in ("經過", "越嶺", "越關", "過橋", "渡河", "出發")):
        return "passed"
    return "unknown"


def candidate_movement(status: str) -> str:
    if "他人" in status:
        return "other_person"
    if "追述" in status:
        return "historical_memory"
    if "眺望" in status or "遠望" in status:
        return "viewed"
    if any(token in status for token in ("支路", "道路", "岔路", "方位", "路線", "路线")):
        return "direction"
    if "提及" in status or "志書" in status or "志书" in status:
        return "referenced"
    return "unknown"


def confidence(place: dict[str, Any]) -> str:
    status = location_status(place.get("定位狀態"))
    source = clean(place.get("坐標來源"))
    if status == "locatable" and any(token in source for token in ("CHGIS", "OpenStreetMap", "人工核定")):
        return "high"
    if status in {"locatable", "regional"}:
        return "medium"
    return "low"


def coordinate_review(place: dict[str, Any]) -> bool:
    return (
        gis_decision(place.get("GIS收錄判定")) == "review"
        or location_status(place.get("定位狀態")) != "locatable"
        or confidence(place) != "high"
    )


def mention(
    *,
    project_id: str,
    sequence: int,
    sort_order: int,
    date: str,
    name: str,
    status: str,
    evidence: str,
    place: dict[str, Any],
    previous_name: str,
    next_name: str,
    is_route: bool,
) -> dict[str, Any]:
    lat = place.get("緯度")
    lon = place.get("經度")
    has_coordinate = isinstance(lat, (int, float)) and isinstance(lon, (int, float))
    coord_review = coordinate_review(place) if has_coordinate else True
    decision_reason = (
        "原文記作實際行程事件；坐標是否精確仍與行程判定分開審核。"
        if is_route
        else f"原判定為「{status}」；保留在待核層，供使用者依上下文決定是否納入路線。"
    )
    return {
        "id": f"{project_id}-{sort_order}-{name}",
        "sequence": sequence,
        "sourceOrder": sort_order,
        "dateLabel": date,
        "originalName": name,
        "normalizedName": name,
        "placeType": clean(place.get("地名類型")) or "待核地名",
        "administrativeLevel": admin_level(place, name),
        "gisDecision": gis_decision(place.get("GIS收錄判定")),
        "recordLevel": "core" if is_route else "review",
        "evidence": evidence,
        "context": evidence,
        "autoDecision": "visited" if is_route else "not_visited",
        "manualDecision": None,
        "visitReviewRequired": not is_route,
        "movementType": movement_type(status) if is_route else candidate_movement(status),
        "movementLabel": status,
        "locationStatus": location_status(place.get("定位狀態")),
        "aliasRelation": "",
        "prefecture": clean(place.get("府級歸屬")),
        "county": clean(place.get("縣級歸屬")),
        "previousActualPlace": previous_name,
        "nextActualPlace": next_name,
        "adjacencyType": "unknown",
        "decisionReason": decision_reason,
        "latitude": float(lat) if has_coordinate else None,
        "longitude": float(lon) if has_coordinate else None,
        "coordinateSource": clean(place.get("坐標來源")),
        "coordinateEvidence": clean(place.get("坐標證據")),
        "coordinateSourceUrl": clean(place.get("坐標來源連結")),
        "coordinateReviewRequired": coord_review,
        "coordinateDecision": None if coord_review else "accepted",
        "confidence": confidence(place),
        "reviewRequired": (not is_route) or coord_review,
    }


def project_from_module(project_id: str, title: str, docx_path: Path, module: Any) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for route_index, (date, name, status, evidence) in enumerate(module.ROUTE_EVENTS):
        previous_name = module.ROUTE_EVENTS[route_index - 1][1] if route_index else ""
        next_name = module.ROUTE_EVENTS[route_index + 1][1] if route_index + 1 < len(module.ROUTE_EVENTS) else ""
        items.append(
            {
                "sortOrder": (route_index + 1) * 10,
                "date": date,
                "name": name,
                "status": status,
                "evidence": evidence,
                "previous": previous_name,
                "next": next_name,
                "route": True,
            }
        )
    for order, date, name, status, evidence, previous_name, next_name in module.CANDIDATES:
        items.append(
            {
                "sortOrder": order,
                "date": date,
                "name": name,
                "status": status,
                "evidence": evidence,
                "previous": previous_name,
                "next": next_name,
                "route": False,
            }
        )
    items.sort(key=lambda row: row["sortOrder"])
    mentions = [
        mention(
            project_id=project_id,
            sequence=index,
            sort_order=int(row["sortOrder"]),
            date=clean(row["date"]),
            name=clean(row["name"]),
            status=clean(row["status"]),
            evidence=clean(row["evidence"]),
            place=module.PLACES[clean(row["name"])],
            previous_name=clean(row["previous"]),
            next_name=clean(row["next"]),
            is_route=bool(row["route"]),
        )
        for index, row in enumerate(items, start=1)
    ]
    geocoded = sum(1 for row in mentions if row["latitude"] is not None and row["longitude"] is not None)
    return {
        "schema": "travelogue-gis-project/v3",
        "projectId": project_id,
        "projectTitle": title,
        "travelDate": "明崇禎年間",
        "summary": f"共 {len(mentions)} 次地名提及，{geocoded} 筆已有坐標；路線與坐標待核項可分開人工判定。",
        "sourceText": source_text(docx_path),
        "sourceFilename": docx_path.name,
        "sourceSignature": source_signature(docx_path),
        "analysisMode": "reviewed_research_dataset",
        "externalData": "",
        "researchSources": [
            {"name": "CHGIS", "role": "歷史行政地名優先來源"},
            {"name": "OpenStreetMap", "role": "現代地名與坐標候選"},
            {"name": "原文方位與里程", "role": "無精確來源時的約略推定；不是精確坐標"},
        ],
        "methodNotes": {
            "route": "只按原文先後連接已確認經過且有坐標的相鄰記錄；直線不代表歷史道路。",
            "coordinatePriority": "CHGIS／OpenStreetMap 已核實坐標不以地方志推定覆寫。",
            "liConversion": "地方志相對方位推定採 1 古里 = 576 米，並保留方向與距離不確定性。",
        },
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "mentions": mentions,
    }


def infer_admin_level_from_mention(row: dict[str, Any]) -> str:
    label = " ".join(clean(row.get(field)) for field in ("normalizedName", "originalName", "placeType"))
    if "府城" in label or label.endswith("府"):
        return "prefecture"
    if any(token in label for token in ("縣／", "县／", "縣治", "县治", "縣城", "县城")) or label.endswith(("縣", "县")):
        return "county"
    return "other"


def zhejiang_project(docx_path: Path) -> dict[str, Any]:
    sample_path = ROOT / "data" / "sample_project.json"
    payload = json.loads(sample_path.read_text(encoding="utf-8"))
    payload.update(
        {
            "schema": "travelogue-gis-project/v3",
            "projectId": "zheyou",
            "projectTitle": "徐霞客《浙遊日記》",
            "sourceText": source_text(docx_path),
            "sourceFilename": docx_path.name,
            "sourceSignature": source_signature(docx_path),
            "analysisMode": "reviewed_research_dataset",
            "methodNotes": {
                "route": "只按原文先後連接已確認經過且有坐標的相鄰記錄；直線不代表歷史道路。",
                "coordinatePriority": "CHGIS／OpenStreetMap 已核實坐標不以地方志推定覆寫。",
                "liConversion": "地方志相對方位推定採 1 古里 = 576 米，並保留方向與距離不確定性。",
            },
        }
    )
    for row in payload["mentions"]:
        row["administrativeLevel"] = row.get("administrativeLevel") or infer_admin_level_from_mention(row)
        row["visitReviewRequired"] = bool(row.get("autoDecision") != "visited")
        coord_review = bool(
            row.get("gisDecision") == "review"
            or row.get("locationStatus") != "locatable"
            or row.get("confidence") != "high"
        )
        row["coordinateReviewRequired"] = coord_review
        row["coordinateDecision"] = None if coord_review else "accepted"
        row["reviewRequired"] = row["visitReviewRequired"] or coord_review
    payload["summary"] = (
        f"共 {len(payload['mentions'])} 次有坐標地名提及；保留既有人工審核資料，"
        "並可再次覆核行程狀態與坐標。"
    )
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data" / "projects")
    parser.add_argument("--qianyou-docx", type=Path, default=DEFAULT_DOCS["qianyou1"])
    parser.add_argument("--yuexi-docx", type=Path, default=DEFAULT_DOCS["yuexi4"])
    parser.add_argument("--zheyou-docx", type=Path, default=DEFAULT_DOCS["zheyou"])
    args = parser.parse_args()

    paths = {
        "qianyou1": args.qianyou_docx.resolve(),
        "yuexi4": args.yuexi_docx.resolve(),
        "zheyou": args.zheyou_docx.resolve(),
    }
    for path in paths.values():
        if not path.exists():
            raise FileNotFoundError(path)

    projects = {
        "zheyou": zhejiang_project(paths["zheyou"]),
        "yuexi4": project_from_module("yuexi4", "徐霞客《粵西遊記四》", paths["yuexi4"], yuexi),
        "qianyou1": project_from_module("qianyou1", "徐霞客《黔遊日記一》", paths["qianyou1"], qianyou),
    }
    shidian_count = apply_shidian_evidence(
        projects["qianyou1"],
        [WORK / "shidian_test20_data.json", WORK / "shidian_supplement.json"],
    )
    if shidian_count:
        projects["qianyou1"]["summary"] += f" 已併入 {shidian_count} 條識典地方志／古籍查證。"
    yuexi_shidian_count = apply_shidian_evidence(
        projects["yuexi4"],
        [WORK / "shidian_supplement.json"],
    )
    if yuexi_shidian_count:
        projects["yuexi4"]["summary"] += f" 已併入 {yuexi_shidian_count} 條識典地方志／古籍查證。"
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, Any]] = []
    for project_id, payload in projects.items():
        destination = output_dir / f"{project_id}.json"
        destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        mentions = payload["mentions"]
        manifest.append(
            {
                "id": project_id,
                "title": payload["projectTitle"],
                "filename": payload["sourceFilename"],
                "summary": payload["summary"],
                "mentionCount": len(mentions),
                "geocodedCount": sum(1 for row in mentions if row.get("latitude") is not None and row.get("longitude") is not None),
                "routeCount": sum(1 for row in mentions if row.get("autoDecision") == "visited"),
                "reviewCount": sum(1 for row in mentions if row.get("reviewRequired")),
                "dataFile": destination.name,
            }
        )
    (output_dir / "index.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

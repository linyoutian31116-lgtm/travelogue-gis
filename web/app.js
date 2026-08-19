/* global L */
(function () {
  "use strict";

  const DECISIONS = new Set(["visited", "not_visited", "uncertain"]);
  const DECISION_LABELS = {
    visited: "經過",
    not_visited: "未經過",
    uncertain: "無法判斷",
    pending: "待人工",
  };
  const MOVEMENT_LABELS = {
    reached: "到達",
    passed: "經過",
    stayed: "停宿／停泊",
    visited: "遊覽",
    viewed: "遙望",
    direction: "方向或支路",
    referenced: "一般提及",
    other_person: "他人行程",
    historical_memory: "歷史回憶",
    unknown: "無法判定",
  };
  const GIS_LABELS = { keep: "GIS 保留", discard: "GIS 不保留", review: "GIS 待核" };
  const RECORD_LABELS = {
    core: "核心地名", route_landmark: "路線輔助地標", excluded: "排除項", review: "待核地名",
  };
  const LOCATION_LABELS = {
    locatable: "可定位", regional: "區域級定位", relative: "相對位置",
    unlocatable: "無法定位", unverified: "未查證",
  };
  const ADMIN_LABELS = { prefecture: "府級", county: "縣級", other: "其他經過地點" };
  const SHIDIAN_TYPE_LABELS = {
    gazetteer: "地方志",
    historical_itinerary: "古籍行程",
    travelogue_transcription: "遊記轉錄",
  };
  const STORAGE_PREFIX = "travelogue-gis-web:workspace:v2:";
  const LAST_PROJECT_KEY = "travelogue-gis-web:last-project:v2";
  const WARNING_KM = 150;

  const elements = Object.fromEntries(
    [
      "save-indicator", "new-project-button", "submit-button", "pending-pill",
      "review-count", "project-title", "travel-date", "external-data", "source-text", "character-count", "file-drop",
      "file-input", "agent-status", "analyze-button", "load-sample-button", "review-title",
      "project-library-list", "library-count",
      "project-summary", "review-search", "review-filter", "progress-label", "progress-bar",
      "add-place-button", "resolve-pending-button", "mention-list", "export-readiness",
      "map-empty", "map-metrics", "map-legend", "fit-map-button", "change-banner",
      "metric-mentions", "metric-geocoded", "metric-route", "metric-warnings",
      "edit-dialog", "edit-form", "edit-dialog-title", "edit-id", "edit-original-name",
      "edit-normalized-name", "edit-date", "edit-type", "edit-administrative-level", "edit-gis-decision", "edit-record-level",
      "edit-movement-type", "edit-location-status", "edit-sequence", "edit-confidence",
      "edit-prefecture", "edit-county", "edit-alias", "edit-previous-place", "edit-next-place",
      "edit-adjacency-type",
      "edit-latitude", "edit-longitude", "edit-source", "edit-source-url", "edit-evidence",
      "edit-coordinate-evidence", "edit-reason", "delete-mention-button", "geocode-dialog", "geocode-results",
      "toast-region", "busy-overlay", "busy-title", "busy-detail",
    ].map((id) => [id, document.getElementById(id)])
  );

  const state = {
    project: null,
    catalog: [],
    activeProjectId: null,
    serverStatus: null,
    submitted: false,
    committedDecisions: {},
    committedRoutePoints: [],
    dirty: false,
    selectedId: null,
    geocodeTargetId: null,
    warningIds: new Set(),
    markers: new Map(),
    lastRouteMetrics: { routeNodes: 0, segments: 0, warnings: 0 },
  };

  let map;
  let markerLayer;
  let routeLayer;
  let warningLayer;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function validCoordinate(item) {
    return Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))
      && Number(item.latitude) >= -90 && Number(item.latitude) <= 90
      && Number(item.longitude) >= -180 && Number(item.longitude) <= 180;
  }

  function currentDecision(item) {
    return DECISIONS.has(item.manualDecision) ? item.manualDecision : item.autoDecision;
  }

  function committedDecision(item) {
    if (state.submitted && DECISIONS.has(state.committedDecisions[item.id])) {
      return state.committedDecisions[item.id];
    }
    return item.autoDecision;
  }

  function markerDecision(item) {
    if (visitPending(item) || coordinatePending(item)) return "pending";
    return currentDecision(item);
  }

  function visitPending(item) {
    return Boolean(item.visitReviewRequired && !DECISIONS.has(item.manualDecision));
  }

  function coordinatePending(item) {
    return Boolean(
      item.coordinateReviewRequired
      && currentDecision(item) !== "not_visited"
      && !["accepted", "rejected"].includes(item.coordinateDecision)
    );
  }

  function reviewPending(item) {
    return visitPending(item) || coordinatePending(item);
  }

  function administrativeLevel(item) {
    if (["prefecture", "county", "other"].includes(item.administrativeLevel)) return item.administrativeLevel;
    const label = `${item.normalizedName || ""} ${item.originalName || ""} ${item.placeType || ""}`;
    if (label.includes("府城") || /府$/.test(item.normalizedName || "")) return "prefecture";
    if (/(縣|县)(城|治|$)|縣／|县／/.test(label)) return "county";
    return "other";
  }

  function sortedMentions() {
    if (!state.project) return [];
    return [...state.project.mentions].sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }

  function requiredMentions() {
    return sortedMentions().filter((item) => item.visitReviewRequired || item.coordinateReviewRequired);
  }

  function pendingMentions() {
    return requiredMentions().filter(reviewPending);
  }

  function routeMentions() {
    if (state.submitted && state.committedRoutePoints.length) {
      return state.committedRoutePoints;
    }
    return sortedMentions().filter((item) => committedDecision(item) === "visited");
  }

  function haversineKm(a, b) {
    const radius = 6371;
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const dLat = toRadians(Number(b.latitude) - Number(a.latitude));
    const dLon = toRadians(Number(b.longitude) - Number(a.longitude));
    const lat1 = toRadians(Number(a.latitude));
    const lat2 = toRadians(Number(b.latitude));
    const value = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(value));
  }

  function safeProjectTitle() {
    return (state.project?.projectTitle || "遊記行程").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
  }

  function toast(message, kind = "info") {
    const node = document.createElement("div");
    node.className = `toast ${kind === "error" ? "error" : ""}`;
    node.textContent = message;
    elements["toast-region"].appendChild(node);
    window.setTimeout(() => node.remove(), kind === "error" ? 6200 : 3600);
  }

  function showBusy(title, detail) {
    elements["busy-title"].textContent = title;
    elements["busy-detail"].textContent = detail;
    elements["busy-overlay"].hidden = false;
  }

  function hideBusy() {
    elements["busy-overlay"].hidden = true;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const contentType = response.headers.get("Content-Type") || "";
    if (!response.ok) {
      let message = `請求失敗（${response.status}）`;
      if (contentType.includes("json")) {
        const payload = await response.json();
        message = payload.error || message;
      } else {
        message = (await response.text()) || message;
      }
      throw new Error(message);
    }
    return contentType.includes("json") ? response.json() : response.blob();
  }

  function initializeMap() {
    if (typeof L === "undefined") {
      toast("地圖元件載入失敗，請檢查網絡連線後重新整理。", "error");
      return;
    }
    map = L.map("map", { zoomControl: false, preferCanvas: false, minZoom: 2 }).setView([30.4, 120.2], 7);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

    const voyager = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      { maxZoom: 20, attribution: "&copy; OpenStreetMap &copy; CARTO" }
    ).addTo(map);
    const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20,
      attribution: "&copy; OpenStreetMap contributors",
    });
    L.control.layers({ "淺色底圖": voyager, "OpenStreetMap": osm }, null, { position: "bottomright" }).addTo(map);

    routeLayer = L.layerGroup().addTo(map);
    warningLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  function markerIcon(item, warning = false) {
    const decision = markerDecision(item);
    const level = administrativeLevel(item);
    return L.divIcon({
      className: "",
      html: `<div class="place-marker admin-${level} ${decision} ${warning ? "warning" : ""}" aria-label="${escapeHtml(ADMIN_LABELS[level])}，${escapeHtml(DECISION_LABELS[decision] || "待人工")}"></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12],
    });
  }

  function popupHtml(item) {
    const decision = markerDecision(item);
    const level = administrativeLevel(item);
    const sourceLink = item.coordinateSourceUrl
      ? `<a href="${escapeHtml(item.coordinateSourceUrl)}" target="_blank" rel="noopener">查看坐標來源</a>` : "";
    const gazetteer = Array.isArray(item.gazetteerEvidence) ? item.gazetteerEvidence[0] : null;
    const gazetteerHtml = gazetteer ? `<div class="popup-gazetteer"><strong>識典${escapeHtml(SHIDIAN_TYPE_LABELS[gazetteer.evidenceType] || "古籍")}證據</strong><p>${escapeHtml(gazetteer.book)} · ${escapeHtml(gazetteer.conclusion)}</p><p>${escapeHtml(gazetteer.quote)}</p>${gazetteer.url ? `<a href="${escapeHtml(gazetteer.url)}" target="_blank" rel="noopener">查看識典原頁</a>` : ""}</div>` : "";
    return `<div class="map-popup">
      <h3>${escapeHtml(item.normalizedName)}</h3>
      <p><strong>${escapeHtml(DECISION_LABELS[decision] || "待人工")}</strong> · ${escapeHtml(item.movementLabel || MOVEMENT_LABELS[item.movementType] || "無法分類")} · ${escapeHtml(ADMIN_LABELS[level])}</p>
      <p>${escapeHtml(GIS_LABELS[item.gisDecision] || "GIS 待核")} · ${escapeHtml(LOCATION_LABELS[item.locationStatus] || "未查證")} · 可信度 ${item.confidence === "high" ? "高" : item.confidence === "medium" ? "中" : "低"}</p>
      ${(item.prefecture || item.county) ? `<p>${escapeHtml([item.prefecture, item.county].filter(Boolean).join(" · "))}</p>` : ""}
      <p>${escapeHtml(item.evidence || "未提供證據原句")}</p>
      <p>${Number(item.latitude).toFixed(5)}, ${Number(item.longitude).toFixed(5)}${item.coordinateSource ? ` · ${escapeHtml(item.coordinateSource)}` : ""} ${sourceLink}</p>
      ${item.coordinateEvidence ? `<p>定位依據：${escapeHtml(item.coordinateEvidence)}</p>` : ""}
      ${item.decisionReason ? `<p>判定說明：${escapeHtml(item.decisionReason)}</p>` : ""}
      ${gazetteerHtml}
      <button type="button" onclick="window.travelogueGIS.edit('${escapeHtml(item.id)}')" style="border:0;border-radius:6px;padding:5px 8px;background:#1d5357;color:white;font:700 10px inherit;cursor:pointer">編輯與調整坐標</button>
    </div>`;
  }

  function rebuildRoute() {
    if (!map || !state.project) return;
    routeLayer.clearLayers();
    warningLayer.clearLayers();
    state.warningIds = new Set();

    const visited = routeMentions();
    let segments = 0;
    let warnings = 0;

    // Only connect adjacent visited records when both ends have coordinates.
    // A missing-coordinate record therefore creates a visible break instead of a misleading shortcut.
    for (let index = 0; index < visited.length - 1; index += 1) {
      const current = visited[index];
      const following = visited[index + 1];
      if (!validCoordinate(current) || !validCoordinate(following)) continue;
      if (Number(current.latitude) === Number(following.latitude)
        && Number(current.longitude) === Number(following.longitude)) continue;
      const distance = haversineKm(current, following);
      const isWarning = distance > WARNING_KM;
      const line = L.polyline(
        [[current.latitude, current.longitude], [following.latitude, following.longitude]],
        {
          color: isWarning ? "#b85145" : "#00866A",
          weight: isWarning ? 3.4 : 3.1,
          opacity: .88,
          dashArray: isWarning ? "7 7" : null,
        }
      ).bindTooltip(`${current.normalizedName} → ${following.normalizedName} · ${Math.round(distance)} km`)
        .bindPopup(`<div class="map-popup"><h3>${escapeHtml(current.normalizedName)} → ${escapeHtml(following.normalizedName)}</h3><p>${Math.round(distance)} 公里</p><p>此線只表示兩筆相鄰行程記錄的先後關係，不代表實際道路或水路。</p></div>`);
      line.addTo(isWarning ? warningLayer : routeLayer);
      segments += 1;
      if (isWarning) {
        warnings += 1;
        state.warningIds.add(current.id);
        state.warningIds.add(following.id);
      }
    }
    state.lastRouteMetrics = { routeNodes: visited.filter(validCoordinate).length, segments, warnings };
  }

  function renderMap({ fit = false } = {}) {
    if (!map || !state.project) return;
    rebuildRoute();
    markerLayer.clearLayers();
    state.markers.clear();
    const bounds = [];

    for (const item of sortedMentions()) {
      if (!validCoordinate(item)) continue;
      const finalDecision = state.submitted ? committedDecision(item) : currentDecision(item);
      if (state.submitted && finalDecision === "not_visited") continue;
      const marker = L.marker([item.latitude, item.longitude], {
        icon: markerIcon(item, state.warningIds.has(item.id)),
        draggable: true,
        title: item.normalizedName,
        riseOnHover: true,
      });
      marker.bindPopup(popupHtml(item), { maxWidth: 330 });
      marker.on("click", () => selectMention(item.id, false));
      marker.on("dragend", (event) => {
        const position = event.target.getLatLng();
        item.latitude = Number(position.lat.toFixed(7));
        item.longitude = Number(position.lng.toFixed(7));
        item.coordinateSource = "人工拖動調整";
        item.coordinateSourceUrl = "";
        item.coordinateEvidence = "使用者在地圖上拖動核定";
        item.locationStatus = "locatable";
        item.confidence = "high";
        item.coordinateReviewRequired = true;
        item.coordinateDecision = "accepted";
        item.reviewRequired = true;
        markDirty();
        renderAll({ fit: false });
        toast(`已更新「${item.normalizedName}」坐標；提交後重算路線。`);
      });
      marker.addTo(markerLayer);
      state.markers.set(item.id, marker);
      bounds.push([Number(item.latitude), Number(item.longitude)]);
    }

    elements["map-empty"].hidden = true;
    elements["map-metrics"].hidden = false;
    elements["map-legend"].hidden = false;
    elements["fit-map-button"].hidden = false;
    updateMetrics();
    if (fit && bounds.length) {
      map.fitBounds(bounds, { padding: [38, 38], maxZoom: 12 });
    }
  }

  function updateMetrics() {
    const mentions = sortedMentions();
    elements["metric-mentions"].textContent = String(mentions.length);
    elements["metric-geocoded"].textContent = String(mentions.filter(validCoordinate).length);
    elements["metric-route"].textContent = String(state.lastRouteMetrics.routeNodes);
    elements["metric-warnings"].textContent = String(state.lastRouteMetrics.warnings);
  }

  function renderReview() {
    if (!state.project) {
      elements["mention-list"].innerHTML = `<div class="empty-state small"><span>⌖</span><p>尚未有可審核的地名</p></div>`;
      return;
    }
    const query = elements["review-search"].value.trim().toLocaleLowerCase();
    const filter = elements["review-filter"].value;
    const items = sortedMentions().filter((item) => {
      const gazetteerText = (item.gazetteerEvidence || []).map((row) => `${row.book || ""} ${row.quote || ""} ${row.conclusion || ""}`).join(" ");
      const haystack = `${item.originalName} ${item.normalizedName} ${item.evidence} ${item.dateLabel} ${item.prefecture || ""} ${item.county || ""} ${gazetteerText}`.toLocaleLowerCase();
      if (query && !haystack.includes(query)) return false;
      const decision = markerDecision(item);
      if (filter === "pending") return reviewPending(item);
      if (filter === "coordinate_pending") return coordinatePending(item);
      if (filter === "visit_pending") return visitPending(item);
      if (filter === "shidian") return Array.isArray(item.gazetteerEvidence) && item.gazetteerEvidence.length > 0;
      if (filter === "missing") return !validCoordinate(item);
      if (filter === "warnings") return state.warningIds.has(item.id);
      if (filter !== "all") return decision === filter;
      return true;
    });

    if (!items.length) {
      elements["mention-list"].innerHTML = `<div class="empty-state small"><span>✓</span><p>目前篩選條件下沒有記錄</p></div>`;
    } else {
      elements["mention-list"].innerHTML = items.map((item) => {
        const decision = markerDecision(item);
        const coordinate = validCoordinate(item)
          ? `${Number(item.latitude).toFixed(5)}, ${Number(item.longitude).toFixed(5)}`
          : "尚未取得坐標";
        const autoLabel = DECISION_LABELS[item.autoDecision] || "無法判斷";
        const date = item.dateLabel || MOVEMENT_LABELS[item.movementType] || "未標註日期";
        const level = administrativeLevel(item);
        const coordinateStatus = item.coordinateDecision === "accepted" ? "坐標已核定"
          : item.coordinateDecision === "rejected" ? "候選坐標已排除" : "坐標待核定";
        const gazetteer = Array.isArray(item.gazetteerEvidence) ? item.gazetteerEvidence[0] : null;
        return `<article class="mention-card ${state.selectedId === item.id ? "active" : ""} ${state.warningIds.has(item.id) ? "route-warning" : ""}" data-id="${escapeHtml(item.id)}">
          <div class="mention-card-head" data-select="${escapeHtml(item.id)}">
            <span class="sequence-badge">${escapeHtml(item.sequence)}</span>
            <div class="mention-name"><strong>${escapeHtml(item.normalizedName)}</strong><span>${escapeHtml(date)} · Agent：${escapeHtml(autoLabel)}</span></div>
            <span class="confidence-chip ${escapeHtml(item.confidence)}">可信度 ${item.confidence === "high" ? "高" : item.confidence === "medium" ? "中" : "低"}</span>
          </div>
          <div class="classification-row"><span>${escapeHtml(ADMIN_LABELS[level])}</span><span>${escapeHtml(GIS_LABELS[item.gisDecision] || "GIS 待核")}</span><span>${escapeHtml(LOCATION_LABELS[item.locationStatus] || "未查證")}</span>${gazetteer ? `<span class="shidian-chip">識典已查</span>` : ""}</div>
          <p class="evidence">${escapeHtml(item.evidence || "未提供證據原句")}</p>
          ${gazetteer ? `<details class="gazetteer-evidence"><summary>識典${escapeHtml(SHIDIAN_TYPE_LABELS[gazetteer.evidenceType] || "古籍")}證據 · ${escapeHtml(gazetteer.conclusion || "待核")}</summary><div><strong>${escapeHtml(gazetteer.book || "識典古籍")}</strong><p>${escapeHtml(gazetteer.quote || "")}</p><p>${escapeHtml(gazetteer.reason || "")}</p>${gazetteer.direction || gazetteer.li != null ? `<p>相對關係：${escapeHtml(gazetteer.direction || "未註明方向")}${gazetteer.li != null ? ` · ${escapeHtml(gazetteer.li)} 里（${Number(gazetteer.meters).toLocaleString()} 米）` : ""}${gazetteer.base ? ` · 基準：${escapeHtml(gazetteer.base)}` : ""}</p>` : ""}${gazetteer.candidateCoordinate ? `<p>候選坐標：${gazetteer.candidateCoordinate.latitude.toFixed(5)}, ${gazetteer.candidateCoordinate.longitude.toFixed(5)}；${escapeHtml(gazetteer.candidateCoordinate.uncertainty)}</p>` : ""}${gazetteer.url ? `<a href="${escapeHtml(gazetteer.url)}" target="_blank" rel="noopener">開啟識典原頁 ↗</a>` : ""}</div></details>` : ""}
          <div class="coordinate-row ${validCoordinate(item) ? "" : "missing"}">
            <span>${validCoordinate(item) ? "⌖" : "!"}</span><span>${escapeHtml(coordinate)}</span>
            <button type="button" data-geocode="${escapeHtml(item.id)}">${validCoordinate(item) ? "重查坐標" : "搜尋坐標"}</button>
          </div>
          ${item.coordinateReviewRequired && currentDecision(item) !== "not_visited" ? `<div class="coordinate-review-row ${item.coordinateDecision === "accepted" ? "accepted" : item.coordinateDecision === "rejected" ? "rejected" : ""}">
            <span>${escapeHtml(coordinateStatus)}${item.coordinateSource ? ` · ${escapeHtml(item.coordinateSource)}` : ""}</span>
            <span class="coordinate-review-actions">
              <button type="button" data-coordinate-decision="accepted" data-id="${escapeHtml(item.id)}" ${validCoordinate(item) ? "" : "disabled"}>${item.coordinateDecision === "accepted" ? "取消核定" : "接受"}</button>
              <button type="button" data-coordinate-decision="rejected" data-id="${escapeHtml(item.id)}">排除此坐標</button>
            </span>
          </div>` : ""}
          <div class="decision-row">
            <button type="button" data-id="${escapeHtml(item.id)}" data-decision="visited" class="${decision === "visited" ? "active" : ""}">經過</button>
            <button type="button" data-id="${escapeHtml(item.id)}" data-decision="not_visited" class="${decision === "not_visited" ? "active" : ""}">未經過</button>
            <button type="button" data-id="${escapeHtml(item.id)}" data-decision="uncertain" class="${decision === "uncertain" ? "active" : ""}">無法判斷</button>
            <button type="button" data-edit="${escapeHtml(item.id)}" title="編輯">⋯</button>
          </div>
        </article>`;
      }).join("");
    }

    const required = requiredMentions();
    const completed = required.filter((item) => !reviewPending(item)).length;
    const pending = required.length - completed;
    elements["progress-label"].textContent = `${completed} / ${required.length}`;
    elements["progress-bar"].style.width = `${required.length ? (completed / required.length) * 100 : 100}%`;
    elements["review-count"].textContent = String(pending);
    elements["pending-pill"].textContent = String(pending);
    elements["submit-button"].disabled = !state.project || pending > 0;
  }

  function updateProjectHeader() {
    if (!state.project) return;
    elements["review-title"].textContent = state.project.projectTitle || "地名判定";
    const modeLabel = {
      agent: "Agent 結構化分析",
      heuristic: "本地初步抽取",
      reviewed_workbook: "已審核工作簿示例",
    }[state.project.analysisMode] || state.project.analysisMode;
    elements["project-summary"].textContent = `${state.project.summary || ""}${modeLabel ? ` · ${modeLabel}` : ""}`;
    elements["project-title"].value = state.project.projectTitle || "";
    elements["travel-date"].value = state.project.travelDate || "";
    elements["external-data"].value = state.project.externalData || "";
    elements["source-text"].value = state.project.sourceText || "";
    updateCharacterCount();
  }

  function updateExportReadiness() {
    if (!state.project) {
      elements["export-readiness"].className = "export-readiness";
      elements["export-readiness"].innerHTML = "<span>尚未建立專案</span><strong>分析文本後即可匯出</strong>";
      return;
    }
    if (state.submitted && !state.dirty) {
      elements["export-readiness"].className = "export-readiness ready";
      elements["export-readiness"].innerHTML = `<span>判定已提交</span><strong>${state.lastRouteMetrics.routeNodes} 個路線節點 · ${state.lastRouteMetrics.warnings} 個異常跳點</strong>`;
    } else {
      elements["export-readiness"].className = "export-readiness";
      elements["export-readiness"].innerHTML = `<span>${pendingMentions().length ? "仍有待人工記錄" : "路線尚未提交"}</span><strong>可先匯出草稿，提交後才是正式路線</strong>`;
    }
  }

  function updateChangeState() {
    elements["save-indicator"].textContent = !state.project
      ? "尚未建立專案"
      : state.dirty ? "有尚未提交的更改" : state.submitted ? "判定已提交" : "草稿已保存在本機";
    elements["save-indicator"].classList.toggle("dirty", state.dirty);
    elements["change-banner"].hidden = !state.project || !state.dirty;
  }

  function renderAll({ fit = false } = {}) {
    updateProjectHeader();
    rebuildRoute();
    renderMap({ fit });
    renderReview();
    updateExportReadiness();
    updateChangeState();
    saveWorkspace();
  }

  function loadProject(project, { fit = true, restored = false } = {}) {
    if (!project || !Array.isArray(project.mentions)) throw new Error("專案資料格式不正確。")
    state.project = project;
    state.activeProjectId = project.projectId || project.sourceSignature || `local-${Date.now()}`;
    state.submitted = Boolean(project.workflowState?.submitted);
    state.committedDecisions = { ...(project.workflowState?.committedDecisions || {}) };
    state.committedRoutePoints = [...(project.workflowState?.committedRoutePoints || [])];
    state.dirty = false;
    state.selectedId = null;
    normalizeProject();
    renderProjectLibrary();
    renderAll({ fit });
    switchTab("review");
    if (!restored) toast(`已載入「${state.project.projectTitle}」：${state.project.mentions.length} 次地名提及。`);
  }

  function normalizeProject() {
    state.project.mentions.forEach((item, index) => {
      item.id = item.id || `mention-${Date.now()}-${index + 1}`;
      item.sequence = Number(item.sequence) || index + 1;
      item.originalName = String(item.originalName || item.normalizedName || "待命名地點");
      item.normalizedName = String(item.normalizedName || item.originalName);
      item.administrativeLevel = administrativeLevel(item);
      item.autoDecision = DECISIONS.has(item.autoDecision) ? item.autoDecision : "uncertain";
      item.manualDecision = DECISIONS.has(item.manualDecision) ? item.manualDecision : null;
      item.gisDecision = ["keep", "discard", "review"].includes(item.gisDecision)
        ? item.gisDecision : (validCoordinate(item) ? "keep" : "review");
      item.recordLevel = ["core", "route_landmark", "excluded", "review"].includes(item.recordLevel)
        ? item.recordLevel : "core";
      item.locationStatus = ["locatable", "regional", "relative", "unlocatable", "unverified"].includes(item.locationStatus)
        ? item.locationStatus : (validCoordinate(item) ? "locatable" : "unverified");
      item.adjacencyType = ["mileage", "direction", "unknown"].includes(item.adjacencyType)
        ? item.adjacencyType : "unknown";
      item.aliasRelation = String(item.aliasRelation || "");
      item.prefecture = String(item.prefecture || "");
      item.county = String(item.county || "");
      item.previousActualPlace = String(item.previousActualPlace || "");
      item.nextActualPlace = String(item.nextActualPlace || "");
      item.coordinateEvidence = String(item.coordinateEvidence || "");
      item.movementLabel = String(item.movementLabel || "");
      item.visitReviewRequired = typeof item.visitReviewRequired === "boolean"
        ? item.visitReviewRequired : item.autoDecision !== "visited";
      item.coordinateReviewRequired = typeof item.coordinateReviewRequired === "boolean"
        ? item.coordinateReviewRequired
        : Boolean(item.gisDecision === "review" || item.confidence !== "high" || item.locationStatus !== "locatable");
      item.coordinateDecision = ["accepted", "rejected"].includes(item.coordinateDecision) ? item.coordinateDecision
        : (item.coordinateReviewRequired ? null : "accepted");
      item.reviewRequired = Boolean(item.visitReviewRequired || item.coordinateReviewRequired);
      if (!validCoordinate(item)) {
        item.latitude = null;
        item.longitude = null;
      } else {
        item.latitude = Number(item.latitude);
        item.longitude = Number(item.longitude);
      }
    });
  }

  function markDirty() {
    state.dirty = true;
    updateChangeState();
    saveWorkspace();
  }

  function workspaceKey(projectId = state.activeProjectId) {
    return `${STORAGE_PREFIX}${projectId || "local"}`;
  }

  function saveWorkspace() {
    if (!state.project) return;
    try {
      const project = JSON.parse(JSON.stringify(state.project));
      project.workflowState = {
        submitted: state.submitted,
        committedDecisions: state.committedDecisions,
        committedRoutePoints: state.committedRoutePoints,
      };
      localStorage.setItem(workspaceKey(), JSON.stringify(project));
      localStorage.setItem(LAST_PROJECT_KEY, state.activeProjectId || "");
    } catch (_error) {
      // The workflow remains usable if storage is unavailable.
    }
  }

  function restoreWorkspace(projectId) {
    try {
      const saved = JSON.parse(localStorage.getItem(workspaceKey(projectId)) || "null");
      if (saved && Array.isArray(saved.mentions)) {
        loadProject(saved, { fit: true, restored: true });
        return true;
      }
    } catch (_error) {
      localStorage.removeItem(workspaceKey(projectId));
    }
    return false;
  }

  function readWorkspace(projectId) {
    try {
      const saved = JSON.parse(localStorage.getItem(workspaceKey(projectId)) || "null");
      return saved && Array.isArray(saved.mentions) ? saved : null;
    } catch (_error) {
      localStorage.removeItem(workspaceKey(projectId));
      return null;
    }
  }

  function mergeLibraryWorkspace(fresh, saved) {
    if (!saved) return fresh;
    const savedById = new Map(saved.mentions.map((item) => [item.id, item]));
    const freshIds = new Set(fresh.mentions.map((item) => item.id));
    const mentions = fresh.mentions.map((item) => {
      const prior = savedById.get(item.id);
      if (!prior) return item;
      return {
        ...item,
        ...prior,
        gazetteerEvidence: item.gazetteerEvidence || prior.gazetteerEvidence,
        gazetteerReviewStatus: item.gazetteerReviewStatus || prior.gazetteerReviewStatus,
        coordinateReviewRequired: item.gazetteerEvidence ? true : prior.coordinateReviewRequired,
        coordinateDecision: item.gazetteerEvidence && !prior.gazetteerEvidence ? null : prior.coordinateDecision,
      };
    });
    saved.mentions.filter((item) => !freshIds.has(item.id)).forEach((item) => mentions.push(item));
    return {
      ...saved,
      ...fresh,
      mentions,
      workflowState: saved.workflowState || fresh.workflowState,
    };
  }

  function renderProjectLibrary() {
    if (!elements["project-library-list"]) return;
    elements["library-count"].textContent = `${state.catalog.length} 篇`;
    elements["project-library-list"].innerHTML = state.catalog.length
      ? state.catalog.map((entry, index) => `<button type="button" class="project-card ${entry.id === state.activeProjectId ? "active" : ""}" data-library-project="${escapeHtml(entry.id)}">
          <i>${index + 1}</i><div><strong>${escapeHtml(entry.title)}</strong><small>${entry.mentionCount} 次提及 · ${entry.routeCount} 個行程節點 · ${entry.reviewCount} 筆需覆核</small></div><span>›</span>
        </button>`).join("")
      : `<div class="library-loading">尚未建立預載文本資料。</div>`;
  }

  async function loadCatalog() {
    try {
      state.catalog = await api("/api/projects");
      renderProjectLibrary();
      const requested = localStorage.getItem(LAST_PROJECT_KEY);
      const projectId = state.catalog.some((entry) => entry.id === requested)
        ? requested : state.catalog[0]?.id;
      if (projectId) await loadLibraryProject(projectId, { restored: true });
    } catch (error) {
      renderProjectLibrary();
      toast(`無法載入文本資料庫：${error.message}`, "error");
    }
  }

  async function loadLibraryProject(projectId, { restored = false } = {}) {
    const entry = state.catalog.find((row) => row.id === projectId);
    showBusy("正在載入研究文本", entry?.title || projectId);
    try {
      const fresh = await api(`/api/projects/${encodeURIComponent(projectId)}`);
      const saved = readWorkspace(projectId);
      const project = mergeLibraryWorkspace(fresh, saved);
      loadProject(project, { fit: true, restored: restored || Boolean(saved) });
    } catch (error) {
      toast(error.message, "error");
    } finally {
      hideBusy();
    }
  }

  function switchTab(tab) {
    document.querySelectorAll(".step-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tab));
  }

  function selectMention(id, moveMap = true) {
    state.selectedId = id;
    renderReview();
    if (moveMap) {
      const marker = state.markers.get(id);
      if (marker) {
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 11), { animate: true });
        marker.openPopup();
      }
    }
    const card = elements["mention-list"].querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function setDecision(id, decision) {
    const item = state.project?.mentions.find((mention) => mention.id === id);
    if (!item || !DECISIONS.has(decision)) return;
    item.manualDecision = decision;
    item.reviewRequired = true;
    markDirty();
    renderAll({ fit: false });
  }

  function setCoordinateDecision(id, decision) {
    const item = state.project?.mentions.find((mention) => mention.id === id);
    if (!item) return;
    if (decision === "accepted" && !validCoordinate(item)) {
      toast("這筆記錄尚無可核定的坐標。", "error");
      return;
    }
    item.coordinateReviewRequired = true;
    if (decision === "accepted") {
      item.coordinateDecision = item.coordinateDecision === "accepted" ? null : "accepted";
    } else if (decision === "rejected") {
      if (validCoordinate(item)) {
        item.rejectedCoordinate = { latitude: item.latitude, longitude: item.longitude, source: item.coordinateSource };
      }
      item.latitude = null;
      item.longitude = null;
      item.coordinateDecision = "rejected";
      item.coordinateEvidence = `${item.coordinateEvidence || ""}${item.coordinateEvidence ? "；" : ""}使用者排除此坐標候選`;
    }
    if (item.coordinateDecision === "accepted" && !item.coordinateEvidence) {
      item.coordinateEvidence = "使用者於網頁人工接受此坐標";
    }
    markDirty();
    renderAll({ fit: false });
  }

  function submitDecisions() {
    if (!state.project) return;
    const pending = pendingMentions();
    if (pending.length) {
      toast(`仍有 ${pending.length} 筆需要人工判定。`, "error");
      switchTab("review");
      return;
    }
    state.committedDecisions = Object.fromEntries(
      state.project.mentions.map((item) => [item.id, currentDecision(item)])
    );
    state.committedRoutePoints = sortedMentions()
      .filter((item) => state.committedDecisions[item.id] === "visited")
      .map((item) => ({
        id: item.id,
        sequence: item.sequence,
        normalizedName: item.normalizedName,
        administrativeLevel: item.administrativeLevel,
        dateLabel: item.dateLabel,
        latitude: item.latitude,
        longitude: item.longitude,
      }));
    state.submitted = true;
    state.dirty = false;
    state.project.lastSubmittedAt = new Date().toISOString();
    renderAll({ fit: true });
    toast(`路線已更新：${state.lastRouteMetrics.routeNodes} 個節點，${state.lastRouteMetrics.warnings} 個異常跳點。`);
  }

  function updateCharacterCount() {
    elements["character-count"].textContent = `${elements["source-text"].value.length.toLocaleString()} 字`;
  }

  async function checkStatus() {
    try {
      state.serverStatus = await api("/api/status");
      const configured = state.serverStatus.agentConfigured;
      const prompt = state.serverStatus.prompt || {};
      const promptLabel = prompt.configured
        ? `${prompt.filename} · ${Number(prompt.characters || 0).toLocaleString()} 字`
        : "Agent Prompt 未載入";
      elements["agent-status"].className = `agent-status ${configured ? "ready" : "local"}`;
      elements["agent-status"].innerHTML = configured
        ? `<span class="status-dot"></span><div><strong>Prompt Agent 已就緒</strong><small>${escapeHtml(state.serverStatus.model)} · ${escapeHtml(promptLabel)}${state.serverStatus.webSearchEnabled ? " · 限定來源搜尋" : ""}</small></div>`
        : `<span class="status-dot"></span><div><strong>Prompt 已載入；目前使用本地初步抽取</strong><small>${escapeHtml(promptLabel)} · 設定 OPENAI_API_KEY 後啟用完整 Agent</small></div>`;
    } catch (error) {
      elements["agent-status"].className = "agent-status local";
      elements["agent-status"].innerHTML = `<span class="status-dot"></span><div><strong>本機服務未連接</strong><small>${escapeHtml(error.message)}</small></div>`;
    }
  }

  async function analyzeSource() {
    const text = elements["source-text"].value.trim();
    const title = elements["project-title"].value.trim();
    const travelDate = elements["travel-date"].value.trim();
    const externalData = elements["external-data"].value.trim();
    if (text.length < 5) {
      toast("請先貼入一段遊記文本。", "error");
      elements["source-text"].focus();
      return;
    }
    showBusy(
      state.serverStatus?.agentConfigured ? "Agent 正在整理遊記" : "正在進行本地初步抽取",
      state.serverStatus?.agentConfigured ? "按指定 Prompt 判定 GIS 收錄、行程狀態、定位與來源證據。" : "將使用保守規則標記候選地名，之後可逐筆修正。"
    );
    try {
      const project = await api("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ text, projectTitle: title, travelDate, externalData }),
      });
      loadProject(project);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      hideBusy();
    }
  }

  async function loadSample() {
    if (state.catalog.some((entry) => entry.id === "zheyou")) {
      await loadLibraryProject("zheyou");
      return;
    }
    showBusy("正在載入徐霞客示例", "將已審核工作簿轉成可再次調整的網頁專案。 ");
    try {
      const project = await api("/api/sample");
      loadProject(project);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      hideBusy();
    }
  }

  async function readFile(file) {
    if (!file) return;
    showBusy("正在讀取文件", file.name);
    try {
      if (file.name.toLocaleLowerCase().endsWith(".json")) {
        const raw = await file.text();
        const project = JSON.parse(raw);
        if (project?.schema === "xu-xiake-route-review/v1" && Array.isArray(project.decisions)) {
          const workbook = String(project.sourceWorkbook || "");
          const targetId = workbook.includes("浙游") || workbook.includes("浙遊") ? "zheyou"
            : workbook.includes("粵西") || workbook.includes("粤西") ? "yuexi4"
              : workbook.includes("黔游") || workbook.includes("黔遊") ? "qianyou1" : state.activeProjectId;
          if (targetId && targetId !== state.activeProjectId && state.catalog.some((entry) => entry.id === targetId)) {
            await loadLibraryProject(targetId);
          }
          if (!state.project) throw new Error("請先載入要套用人工判定的文本專案。")
          let applied = 0;
          project.decisions.forEach((decision) => {
            const item = state.project.mentions.find((mention) => (
              Number(mention.sourceRow) === Number(decision.excelRow)
              || (mention.normalizedName === decision.normalizedPlace
                && (!decision.date || mention.dateLabel === decision.date)
                && (!decision.evidence || mention.evidence === decision.evidence))
            ));
            if (!item) return;
            const label = String(decision.manualDecision || "");
            item.manualDecision = ["經過", "经过", "是"].includes(label) ? "visited"
              : ["未經過", "未经过", "非經過", "否"].includes(label) ? "not_visited" : "uncertain";
            item.visitReviewRequired = true;
            item.reviewRequired = true;
            item.decisionReason = `${item.decisionReason || ""}${item.decisionReason ? "；" : ""}匯入舊版人工判定：${label}`;
            applied += 1;
          });
          state.project.reviewImports = [...(state.project.reviewImports || []), {
            filename: file.name, schema: project.schema, submittedAt: project.submittedAt || "", applied,
          }];
          markDirty();
          renderAll({ fit: false });
          toast(`已從舊版判定 JSON 套用 ${applied} 筆結果。`);
          return;
        }
        if (!project || !Array.isArray(project.mentions)) throw new Error("JSON 不是有效的行旅地圖專案或舊版人工判定。")
        project.projectId = project.projectId || `import-${Date.now()}`;
        loadProject(project);
        toast(`已恢復「${project.projectTitle || file.name}」的審核資料。`);
        return;
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
        reader.onerror = () => reject(new Error("無法讀取文件。"));
        reader.readAsDataURL(file);
      });
      const result = await api("/api/extract-file", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, data }),
      });
      elements["source-text"].value = result.text;
      if (!elements["project-title"].value.trim()) {
        elements["project-title"].value = file.name.replace(/\.[^.]+$/, "");
      }
      updateCharacterCount();
      toast(`已讀取 ${result.characters.toLocaleString()} 字。`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      hideBusy();
      elements["file-input"].value = "";
    }
  }

  function openEdit(id = null) {
    const item = id ? state.project?.mentions.find((mention) => mention.id === id) : null;
    elements["edit-dialog-title"].textContent = item ? `編輯「${item.normalizedName}」` : "新增地點";
    elements["edit-id"].value = item?.id || "";
    elements["edit-original-name"].value = item?.originalName || "";
    elements["edit-normalized-name"].value = item?.normalizedName || "";
    elements["edit-date"].value = item?.dateLabel || "";
    elements["edit-type"].value = item?.placeType || "待核地名";
    elements["edit-administrative-level"].value = item ? administrativeLevel(item) : "other";
    elements["edit-gis-decision"].value = item?.gisDecision || "review";
    elements["edit-record-level"].value = item?.recordLevel || "review";
    elements["edit-movement-type"].value = item?.movementType || "unknown";
    elements["edit-location-status"].value = item?.locationStatus || "unverified";
    elements["edit-sequence"].value = item?.sequence || (state.project?.mentions.length || 0) + 1;
    elements["edit-confidence"].value = item?.confidence || "low";
    elements["edit-prefecture"].value = item?.prefecture || "";
    elements["edit-county"].value = item?.county || "";
    elements["edit-alias"].value = item?.aliasRelation || "";
    elements["edit-previous-place"].value = item?.previousActualPlace || "";
    elements["edit-next-place"].value = item?.nextActualPlace || "";
    elements["edit-adjacency-type"].value = item?.adjacencyType || "unknown";
    elements["edit-latitude"].value = validCoordinate(item || {}) ? item.latitude : "";
    elements["edit-longitude"].value = validCoordinate(item || {}) ? item.longitude : "";
    elements["edit-source"].value = item?.coordinateSource || "";
    elements["edit-coordinate-evidence"].value = item?.coordinateEvidence || "";
    elements["edit-source-url"].value = item?.coordinateSourceUrl || "";
    elements["edit-evidence"].value = item?.evidence || "";
    elements["edit-reason"].value = item?.decisionReason || "";
    elements["delete-mention-button"].hidden = !item;
    elements["edit-dialog"].showModal();
  }

  function saveEdit(event) {
    event.preventDefault();
    if (!state.project) {
      toast("請先建立專案。", "error");
      return;
    }
    const id = elements["edit-id"].value;
    let item = id ? state.project.mentions.find((mention) => mention.id === id) : null;
    if (!item) {
      item = {
        id: `manual-${Date.now()}`,
        autoDecision: "uncertain",
        manualDecision: null,
        movementType: "unknown",
        gisDecision: "review",
        recordLevel: "review",
        locationStatus: "unverified",
        adjacencyType: "unknown",
        context: "",
        visitReviewRequired: true,
        coordinateReviewRequired: true,
        coordinateDecision: null,
        reviewRequired: true,
      };
      state.project.mentions.push(item);
    }
    item.originalName = elements["edit-original-name"].value.trim();
    item.normalizedName = elements["edit-normalized-name"].value.trim() || item.originalName;
    if (!item.originalName || !item.normalizedName) {
      toast("請填寫原文地名與規範地名。", "error");
      return;
    }
    item.dateLabel = elements["edit-date"].value.trim();
    item.placeType = elements["edit-type"].value.trim() || "待核地名";
    item.administrativeLevel = elements["edit-administrative-level"].value;
    item.gisDecision = elements["edit-gis-decision"].value;
    item.recordLevel = elements["edit-record-level"].value;
    item.movementType = elements["edit-movement-type"].value;
    item.locationStatus = elements["edit-location-status"].value;
    item.sequence = Number(elements["edit-sequence"].value) || state.project.mentions.length;
    item.confidence = elements["edit-confidence"].value;
    item.prefecture = elements["edit-prefecture"].value.trim();
    item.county = elements["edit-county"].value.trim();
    item.aliasRelation = elements["edit-alias"].value.trim();
    item.previousActualPlace = elements["edit-previous-place"].value.trim();
    item.nextActualPlace = elements["edit-next-place"].value.trim();
    item.adjacencyType = elements["edit-adjacency-type"].value;
    const lat = Number(elements["edit-latitude"].value);
    const lon = Number(elements["edit-longitude"].value);
    item.latitude = Number.isFinite(lat) && elements["edit-latitude"].value !== "" ? lat : null;
    item.longitude = Number.isFinite(lon) && elements["edit-longitude"].value !== "" ? lon : null;
    item.coordinateSource = elements["edit-source"].value.trim();
    item.coordinateEvidence = elements["edit-coordinate-evidence"].value.trim();
    item.coordinateSourceUrl = elements["edit-source-url"].value.trim();
    item.evidence = elements["edit-evidence"].value.trim();
    item.context = item.context || item.evidence;
    item.decisionReason = elements["edit-reason"].value.trim();
    item.coordinateReviewRequired = true;
    item.coordinateDecision = null;
    item.reviewRequired = true;
    elements["edit-dialog"].close();
    markDirty();
    renderAll({ fit: validCoordinate(item) });
    toast(`已保存「${item.normalizedName}」。`);
  }

  function deleteEditedMention() {
    const id = elements["edit-id"].value;
    const item = state.project?.mentions.find((mention) => mention.id === id);
    if (!item || !window.confirm(`確定刪除「${item.normalizedName}」這筆地名提及？`)) return;
    state.project.mentions = state.project.mentions.filter((mention) => mention.id !== id);
    delete state.committedDecisions[id];
    elements["edit-dialog"].close();
    markDirty();
    renderAll({ fit: false });
    toast("已刪除地名記錄。 ");
  }

  async function searchCoordinate(id) {
    const item = state.project?.mentions.find((mention) => mention.id === id);
    if (!item) return;
    state.geocodeTargetId = id;
    showBusy("正在搜尋坐標", `${item.normalizedName} · OpenStreetMap`);
    try {
      const queryParts = [item.normalizedName, item.dateLabel].filter(Boolean);
      const payload = await api("/api/geocode", {
        method: "POST",
        body: JSON.stringify({ query: queryParts.join(" "), limit: 6 }),
      });
      if (!payload.results.length && queryParts.length > 1) {
        const fallback = await api("/api/geocode", {
          method: "POST",
          body: JSON.stringify({ query: item.normalizedName, limit: 6 }),
        });
        payload.results = fallback.results;
      }
      elements["geocode-results"].innerHTML = payload.results.length
        ? payload.results.map((result, index) => `<div class="geocode-result">
            <div><strong>${escapeHtml(result.displayName)}</strong><small>${result.latitude.toFixed(5)}, ${result.longitude.toFixed(5)} · ${escapeHtml(result.type || result.category)}</small></div>
            <button type="button" data-geocode-choice="${index}">採用</button>
          </div>`).join("")
        : `<div class="empty-state small"><span>⌖</span><p>找不到候選；可在編輯視窗手工輸入坐標。</p></div>`;
      elements["geocode-results"].dataset.results = JSON.stringify(payload.results);
      elements["geocode-dialog"].showModal();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      hideBusy();
    }
  }

  function chooseGeocode(index) {
    const item = state.project?.mentions.find((mention) => mention.id === state.geocodeTargetId);
    const results = JSON.parse(elements["geocode-results"].dataset.results || "[]");
    const selected = results[index];
    if (!item || !selected) return;
    item.latitude = selected.latitude;
    item.longitude = selected.longitude;
    item.coordinateSource = selected.source;
    item.coordinateSourceUrl = selected.sourceUrl;
    item.coordinateEvidence = selected.displayName;
    item.locationStatus = "locatable";
    item.confidence = "medium";
    item.coordinateReviewRequired = true;
    item.coordinateDecision = null;
    item.reviewRequired = true;
    elements["geocode-dialog"].close();
    markDirty();
    renderAll({ fit: false });
    selectMention(item.id, true);
    toast(`已採用「${item.normalizedName}」的坐標候選，仍請核對同名異地。`);
  }

  function projectForExport() {
    if (!state.project) throw new Error("尚未建立專案。")
    const project = JSON.parse(JSON.stringify(state.project));
    project.exportedAt = new Date().toISOString();
    project.workflowState = {
      submitted: state.submitted,
      dirty: state.dirty,
      committedDecisions: state.committedDecisions,
      committedRoutePoints: state.committedRoutePoints,
      routeMetrics: state.lastRouteMetrics,
    };
    project.mentions.forEach((item) => {
      item.finalDecision = state.submitted
        ? (state.committedDecisions[item.id] || item.autoDecision)
        : currentDecision(item);
    });
    return project;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function csvCell(value) {
    const rendered = String(value == null ? "" : value);
    return `"${rendered.replaceAll('"', '""')}"`;
  }

  function buildGeoJSON(project) {
    const pointFeatures = project.mentions.filter(validCoordinate).map((item) => {
      const gazetteer = (item.gazetteerEvidence || [])[0] || {};
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(item.longitude), Number(item.latitude)] },
        properties: {
        id: item.id,
        sequence: item.sequence,
        date: item.dateLabel,
        originalName: item.originalName,
        normalizedName: item.normalizedName,
        gisDecision: item.gisDecision,
        recordLevel: item.recordLevel,
        movementType: item.movementType,
        locationStatus: item.locationStatus,
        aliasRelation: item.aliasRelation,
        prefecture: item.prefecture,
        county: item.county,
        decision: item.finalDecision,
        evidence: item.evidence,
        coordinateSource: item.coordinateSource,
        coordinateEvidence: item.coordinateEvidence,
        gazetteerBook: gazetteer.book || "",
        gazetteerQuote: gazetteer.quote || "",
        gazetteerConclusion: gazetteer.conclusion || "",
        gazetteerUrl: gazetteer.url || "",
        gazetteerCandidateLatitude: gazetteer.candidateCoordinate?.latitude ?? null,
        gazetteerCandidateLongitude: gazetteer.candidateCoordinate?.longitude ?? null,
      },
      };
    });
    const visited = project.mentions
      .filter((item) => item.finalDecision === "visited")
      .sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const lines = [];
    let currentLine = [];
    for (const item of visited) {
      if (!validCoordinate(item)) {
        if (currentLine.length > 1) lines.push(currentLine);
        currentLine = [];
        continue;
      }
      currentLine.push([Number(item.longitude), Number(item.latitude)]);
    }
    if (currentLine.length > 1) lines.push(currentLine);
    const routeFeature = {
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: lines },
      properties: { name: `${project.projectTitle}－確認路線`, note: "直線只表示相鄰行程記錄，不代表實際道路或水路。" },
    };
    return { type: "FeatureCollection", features: [...pointFeatures, routeFeature] };
  }

  function standaloneMapHtml(project, geojson) {
    const safeData = JSON.stringify({ projectTitle: project.projectTitle, geojson }).replaceAll("</", "<\\/");
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(project.projectTitle)}｜行程地圖</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css"><style>html,body,#map{height:100%;margin:0}body{font-family:Microsoft JhengHei,PingFang TC,sans-serif}.title{position:fixed;z-index:1000;top:12px;left:50px;padding:10px 13px;border-radius:9px;background:#fffdf8ef;box-shadow:0 4px 18px #182f3040}.title b{display:block}.title span{font-size:10px;color:#67777c}.legend{position:fixed;z-index:1000;right:13px;bottom:18px;padding:9px 11px;border-radius:8px;background:#fffdf8ef;font-size:10px;box-shadow:0 4px 18px #182f3040}.dot{display:inline-block;width:9px;height:9px;margin:0 4px 0 9px;border:2px solid white;border-radius:50%;box-shadow:0 0 0 1px #253436}.dot:first-child{margin-left:0}</style></head><body><div id="map"></div><div class="title"><b>${escapeHtml(project.projectTitle)}</b><span>人工審核行程 · 直線不代表實際道路或水路</span></div><div class="legend"><i class="dot" style="background:#6A3D9A"></i>府級<i class="dot" style="background:#0072B2"></i>縣級<i class="dot" style="background:#D55E00"></i>其他經過地點</div><script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"><\/script><script>const data=${safeData};const map=L.map('map').setView([30,120],6);L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{maxZoom:20,attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(map);const colors={prefecture:'#6A3D9A',county:'#0072B2',other:'#D55E00'};const layer=L.geoJSON(data.geojson,{style:f=>({color:'#00866A',weight:3,opacity:.9}),pointToLayer:(f,ll)=>L.circleMarker(ll,{radius:7,color:f.properties.decision==='not_visited'?'#242c2e':'#fff',dashArray:f.properties.decision==='uncertain'?'3 2':null,weight:2,fillColor:colors[f.properties.administrativeLevel]||colors.other,fillOpacity:1}),onEachFeature:(f,l)=>{if(f.geometry.type==='Point')l.bindPopup('<b>'+f.properties.normalizedName+'</b><br>'+f.properties.date+'<br><small>'+f.properties.evidence+'</small>')}}).addTo(map);if(layer.getBounds().isValid())map.fitBounds(layer.getBounds(),{padding:[30,30]});<\/script></body></html>`;
  }

  async function exportProject(kind) {
    try {
      const project = projectForExport();
      if (!state.submitted || state.dirty) toast("目前匯出的是尚未提交的草稿。 ");
      const base = safeProjectTitle();
      if (kind === "json") {
        downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: "application/json;charset=utf-8" }), `${base}_完整專案.json`);
      } else if (kind === "csv") {
        const headers = [
          "順序", "日期", "原文地名", "規範地名", "地名類型", "GIS收錄判定", "記錄層級",
          "經過狀態", "自動判定", "人工判定", "最終判定", "定位狀態", "異名關係",
          "府級歸屬", "縣級歸屬", "上一實際行程地點", "下一實際行程地點", "鄰接關係",
          "緯度", "經度", "坐標來源", "坐標證據", "坐標來源連結", "證據原句", "判定理由",
          "識典書名", "識典原文", "識典結論", "識典方向", "識典里數", "識典候選緯度", "識典候選經度", "識典連結",
        ];
        const rows = project.mentions.sort((a, b) => a.sequence - b.sequence).map((item) => {
          const gazetteer = (item.gazetteerEvidence || [])[0] || {};
          return [
            item.sequence, item.dateLabel, item.originalName, item.normalizedName, item.placeType,
            GIS_LABELS[item.gisDecision], RECORD_LABELS[item.recordLevel], MOVEMENT_LABELS[item.movementType],
            DECISION_LABELS[item.autoDecision], DECISION_LABELS[item.manualDecision] || "",
            DECISION_LABELS[item.finalDecision], LOCATION_LABELS[item.locationStatus], item.aliasRelation,
            item.prefecture, item.county, item.previousActualPlace, item.nextActualPlace, item.adjacencyType,
            item.latitude, item.longitude, item.coordinateSource, item.coordinateEvidence,
            item.coordinateSourceUrl, item.evidence, item.decisionReason,
            gazetteer.book, gazetteer.quote, gazetteer.conclusion, gazetteer.direction, gazetteer.li,
            gazetteer.candidateCoordinate?.latitude, gazetteer.candidateCoordinate?.longitude, gazetteer.url,
          ];
        });
        const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
        downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${base}_地名審核.csv`);
      } else if (kind === "geojson") {
        const geojson = buildGeoJSON(project);
        downloadBlob(new Blob([JSON.stringify(geojson, null, 2)], { type: "application/geo+json;charset=utf-8" }), `${base}_行程.geojson`);
      } else if (kind === "html") {
        const geojson = buildGeoJSON(project);
        downloadBlob(new Blob([standaloneMapHtml(project, geojson)], { type: "text/html;charset=utf-8" }), `${base}_互動地圖.html`);
      } else if (kind === "xlsx") {
        showBusy("正在建立 Excel", "整理地名審核、確認行程與專案資訊。 ");
        const blob = await api("/api/export/xlsx", {
          method: "POST",
          body: JSON.stringify({ project }),
        });
        downloadBlob(blob, `${base}_地名審核.xlsx`);
      }
    } catch (error) {
      toast(error.message, "error");
    } finally {
      hideBusy();
    }
  }

  function resetProject() {
    if (state.project && !window.confirm("確定建立新專案？目前專案仍可先匯出 JSON 保存。")) return;
    state.project = null;
    state.submitted = false;
    state.committedDecisions = {};
    state.committedRoutePoints = [];
    state.dirty = false;
    state.selectedId = null;
    state.activeProjectId = null;
    renderProjectLibrary();
    elements["project-title"].value = "";
    elements["travel-date"].value = "";
    elements["external-data"].value = "";
    elements["source-text"].value = "";
    updateCharacterCount();
    markerLayer?.clearLayers();
    routeLayer?.clearLayers();
    warningLayer?.clearLayers();
    elements["map-empty"].hidden = false;
    elements["map-metrics"].hidden = true;
    elements["map-legend"].hidden = true;
    elements["fit-map-button"].hidden = true;
    renderReview();
    updateExportReadiness();
    updateChangeState();
    switchTab("source");
  }

  function bindEvents() {
    document.querySelectorAll(".step-tab").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
    document.querySelectorAll("[data-jump]").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.jump)));
    elements["source-text"].addEventListener("input", updateCharacterCount);
    elements["analyze-button"].addEventListener("click", analyzeSource);
    elements["load-sample-button"].addEventListener("click", loadSample);
    elements["project-library-list"].addEventListener("click", (event) => {
      const button = event.target.closest("[data-library-project]");
      if (button) loadLibraryProject(button.dataset.libraryProject);
    });
    elements["new-project-button"].addEventListener("click", resetProject);
    elements["submit-button"].addEventListener("click", submitDecisions);
    elements["change-banner"].querySelector("button").addEventListener("click", submitDecisions);
    elements["fit-map-button"].addEventListener("click", () => renderMap({ fit: true }));

    elements["file-drop"].addEventListener("click", () => elements["file-input"].click());
    elements["file-drop"].addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") elements["file-input"].click();
    });
    elements["file-input"].addEventListener("change", () => readFile(elements["file-input"].files[0]));
    ["dragenter", "dragover"].forEach((name) => elements["file-drop"].addEventListener(name, (event) => {
      event.preventDefault();
      elements["file-drop"].classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((name) => elements["file-drop"].addEventListener(name, (event) => {
      event.preventDefault();
      elements["file-drop"].classList.remove("dragging");
    }));
    elements["file-drop"].addEventListener("drop", (event) => readFile(event.dataTransfer.files[0]));

    elements["review-search"].addEventListener("input", renderReview);
    elements["review-filter"].addEventListener("change", renderReview);
    elements["mention-list"].addEventListener("click", (event) => {
      const decisionButton = event.target.closest("[data-decision]");
      if (decisionButton) return setDecision(decisionButton.dataset.id, decisionButton.dataset.decision);
      const coordinateButton = event.target.closest("[data-coordinate-decision]");
      if (coordinateButton) return setCoordinateDecision(coordinateButton.dataset.id, coordinateButton.dataset.coordinateDecision);
      const geocodeButton = event.target.closest("[data-geocode]");
      if (geocodeButton) return searchCoordinate(geocodeButton.dataset.geocode);
      const editButton = event.target.closest("[data-edit]");
      if (editButton) return openEdit(editButton.dataset.edit);
      const selectTarget = event.target.closest("[data-select]");
      if (selectTarget) selectMention(selectTarget.dataset.select, true);
    });
    elements["add-place-button"].addEventListener("click", () => {
      if (!state.project) return toast("請先建立或載入專案。", "error");
      openEdit();
    });
    elements["resolve-pending-button"].addEventListener("click", () => {
      const pending = requiredMentions().filter(visitPending);
      if (!pending.length) return toast("目前沒有待處理記錄。 ");
      if (!window.confirm(`把 ${pending.length} 筆待處理記錄設為「無法判斷」？之後仍可逐筆修改。`)) return;
      pending.forEach((item) => { item.manualDecision = "uncertain"; });
      markDirty();
      renderAll({ fit: false });
    });

    elements["edit-form"].addEventListener("submit", saveEdit);
    elements["delete-mention-button"].addEventListener("click", deleteEditedMention);
    elements["geocode-results"].addEventListener("click", (event) => {
      const button = event.target.closest("[data-geocode-choice]");
      if (button) chooseGeocode(Number(button.dataset.geocodeChoice));
    });
    document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => exportProject(button.dataset.export)));
  }

  window.travelogueGIS = {
    edit: openEdit,
    select: selectMention,
    getProject: projectForExport,
  };

  initializeMap();
  bindEvents();
  updateCharacterCount();
  checkStatus();
  loadCatalog();
  updateExportReadiness();
  updateChangeState();
})();

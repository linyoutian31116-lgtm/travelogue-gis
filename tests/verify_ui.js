const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 920 }, deviceScaleFactor: 1 });
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error"
        && !message.text().includes("ERR_BLOCKED_BY_CLIENT")
        && !message.text().includes("ERR_NETWORK_ACCESS_DENIED")
        && !message.text().includes("ERR_NAME_NOT_RESOLVED")) {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());

    await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#project-library-list .project-card", { state: "attached", timeout: 30000 });
    await page.waitForFunction(() => document.querySelector("#metric-mentions")?.textContent === "98");

    const libraryCount = await page.locator("#project-library-list .project-card").count();
    if (libraryCount !== 3) throw new Error(`Expected 3 bundled projects, got ${libraryCount}`);

    const zhejiang = await page.evaluate(() => ({
      mentions: Number(document.querySelector("#metric-mentions").textContent),
      title: document.querySelector("#review-title").textContent,
      hasPrefecture: Boolean(document.querySelector(".place-marker.admin-prefecture")),
      hasCounty: Boolean(document.querySelector(".place-marker.admin-county")),
      hasOther: Boolean(document.querySelector(".place-marker.admin-other")),
      markerHasSequence: Boolean(document.querySelector(".place-marker span")),
    }));
    if (zhejiang.markerHasSequence) throw new Error("Map markers should not display itinerary sequence numbers");
    if (!zhejiang.hasPrefecture || !zhejiang.hasCounty || !zhejiang.hasOther) {
      throw new Error(`Missing administrative marker classes: ${JSON.stringify(zhejiang)}`);
    }

    await page.click('.step-tab[data-tab="source"]');
    await page.click('[data-library-project="yuexi4"]');
    await page.waitForFunction(() => document.querySelector("#metric-mentions")?.textContent === "70");
    const yuexi = await page.evaluate(() => ({
      mentions: Number(document.querySelector("#metric-mentions").textContent),
      route: Number(document.querySelector("#metric-route").textContent),
      title: document.querySelector("#review-title").textContent,
    }));
    if (yuexi.route !== 61) throw new Error(`Expected 61 Yuexi route nodes, got ${yuexi.route}`);

    await page.click('.step-tab[data-tab="source"]');
    await page.click('[data-library-project="qianyou1"]');
    await page.waitForFunction(() => document.querySelector("#metric-mentions")?.textContent === "103");
    await page.selectOption("#review-filter", "coordinate_pending");
    await page.waitForSelector("#mention-list [data-coordinate-decision='accepted']");
    const pendingBefore = Number(await page.textContent("#pending-pill"));
    await page.click("#mention-list [data-coordinate-decision='accepted']");
    await page.waitForFunction((before) => Number(document.querySelector("#pending-pill").textContent) === before - 1, pendingBefore);
    const pendingAfter = Number(await page.textContent("#pending-pill"));

    const routeColor = await page.evaluate(() => {
      const paths = [...document.querySelectorAll("path.leaflet-interactive")];
      const route = paths.find((path) => (path.getAttribute("stroke") || "").toUpperCase() === "#00866A");
      return route?.getAttribute("stroke") || "";
    });
    if (routeColor.toUpperCase() !== "#00866A") throw new Error(`Emerald route not found; got ${routeColor}`);

    await page.screenshot({ path: "tests/workflow_preview.png", fullPage: true });

    await page.selectOption("#review-filter", "visit_pending");
    await page.waitForSelector("#mention-list [data-decision='not_visited']");
    const beforeVisitDecision = Number(await page.textContent("#pending-pill"));
    await page.click("#mention-list [data-decision='not_visited']");
    await page.waitForFunction((before) => Number(document.querySelector("#pending-pill").textContent) === before - 1, beforeVisitDecision);
    await page.click("#resolve-pending-button");

    await page.selectOption("#review-filter", "coordinate_pending");
    for (let index = 0; index < 120; index += 1) {
      const button = page.locator("#mention-list [data-coordinate-decision='accepted']").first();
      if (!(await button.count())) break;
      await button.click();
    }
    await page.waitForFunction(() => document.querySelector("#pending-pill").textContent === "0");
    if (await page.isDisabled("#submit-button")) throw new Error("Submit should be enabled after both review layers are complete");
    await page.click("#submit-button");
    await page.waitForFunction(() => document.querySelector("#save-indicator").textContent.includes("判定已提交"));
    const submittedRoute = Number(await page.textContent("#metric-route"));
    if (submittedRoute !== 93) throw new Error(`Expected 93 submitted Qianyou route nodes, got ${submittedRoute}`);

    await page.click('.step-tab[data-tab="source"]');
    await page.screenshot({ path: "tests/library_preview.png", fullPage: true });
    await page.setInputFiles("#file-input", "C:\\Users\\yarin\\Downloads\\徐霞客_行程人工判定_2026-08-07T06-29-45Z.json");
    await page.waitForFunction(() => document.querySelector("#review-title").textContent.includes("浙遊日記"));
    const legacyApplied = await page.evaluate(() => window.travelogueGIS.getProject().reviewImports?.at(-1)?.applied || 0);
    if (legacyApplied < 10) throw new Error(`Expected legacy review decisions to be imported, got ${legacyApplied}`);
    if (consoleErrors.length) throw new Error(`Browser errors:\n${consoleErrors.join("\n")}`);
    console.log(JSON.stringify({ libraryCount, zhejiang, yuexi, qianyou: { mentions: 103, pendingBefore, pendingAfter, submittedRoute }, routeColor, legacyApplied }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

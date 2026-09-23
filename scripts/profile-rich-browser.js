// Profile a Chromium Playwright CLI session open on rich.html:
// playwright-cli run-code --filename scripts/profile-rich-browser.js
// Timings include forced layout, exclude font/network loading and paint, and are
// observations from the current device. Run baseline/current/current/baseline.
async (page) => {
  const targetUrl = page.url().split("?")[0];
  page = await page.context().newPage();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.route(
    (url) => url.pathname === "/src/rich.ts",
    async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      if (!body.includes("await document.fonts.ready;") || !body.includes("let lastWidth = 0;"))
        throw new Error("Preparation hooks no longer match");
      body = body
        .replace("await document.fonts.ready;", 'await document.fonts.ready; performance.mark("qa:initial:start");')
        .replace("let lastWidth = 0;", 'performance.mark("qa:prepared"); let lastWidth = 0;');
      await route.fulfill({ response, body });
    },
  );
  await page.addInitScript(() => {
    const metrics = (window.__justiceProfile = { renderVersion: 0, measurementReads: 0, frames: [], phase: "warmup" });
    const bounds = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.closest("#measure")) metrics.measurementReads++;
      return bounds.call(this);
    };
    const replace = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function (...args) {
      const result = replace.apply(this, args);
      if (this.id === "composed") {
        metrics.renderVersion++;
        if (!metrics.initialQueued) {
          metrics.initialQueued = true;
          queueMicrotask(() => {
            this.offsetHeight;
            metrics.initialEnd = performance.now();
            metrics.initialElements = this.querySelectorAll("*").length;
            metrics.initialAnchors = this.querySelectorAll("a").length;
          });
        }
      }
      return result;
    };
    const raf = requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        const before = metrics.renderVersion,
          reads = metrics.measurementReads,
          start = performance.now();
        callback(time);
        const afterScript = performance.now();
        if (metrics.renderVersion !== before) {
          const root = document.querySelector("#composed");
          root.offsetHeight;
          const end = performance.now();
          metrics.frames.push({
            phase: metrics.phase,
            scriptMs: afterScript - start,
            layoutMs: end - afterScript,
            totalMs: end - start,
            measurementReads: metrics.measurementReads - reads,
            elements: root.querySelectorAll("*").length,
            anchors: root.querySelectorAll("a").length,
            width: root.getBoundingClientRect().width,
          });
        }
      });
  });
  const initial = [];
  for (let i = 0; i < 7; i++) {
    await page.goto(targetUrl);
    await page.waitForFunction(() => window.__justiceProfile?.initialEnd !== undefined);
    const item = await page.evaluate(() => {
      const m = __justiceProfile,
        start = performance.getEntriesByName("qa:initial:start").at(-1).startTime,
        prepared = performance.getEntriesByName("qa:prepared").at(-1).startTime;
      return {
        prepareMs: prepared - start,
        renderAndLayoutMs: m.initialEnd - prepared,
        totalMs: m.initialEnd - start,
        measurementReads: m.measurementReads,
        elements: m.initialElements,
        anchors: m.initialAnchors,
        fontLoaded: [...document.fonts].some((face) => face.family.includes("EB Garamond") && face.status === "loaded"),
      };
    });
    if (i > 0) initial.push(item);
  }
  const resize = [];
  for (const viewport of [
    { width: 1200, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(async () => {
      const m = __justiceProfile;
      m.frames = [];
      const readsBefore = m.measurementReads;
      for (let cycle = 0; cycle < 8; cycle++)
        for (const width of [220, 260, 320, 380, 420, 480, 540]) {
          m.phase = cycle < 2 ? "warmup" : "measure";
          const slider = document.querySelector("#width");
          slider.value = String(width);
          slider.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
      const frames = m.frames.filter((f) => f.phase === "measure");
      const stats = (key) => {
        const sorted = frames.map((f) => f[key]).sort((a, b) => a - b);
        return {
          median: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          max: sorted.at(-1),
        };
      };
      return {
        samples: frames.length,
        scriptMs: stats("scriptMs"),
        layoutMs: stats("layoutMs"),
        totalMs: stats("totalMs"),
        measurementReadsDuringResize: m.measurementReads - readsBefore,
        domByWidth: [
          ...new Map(
            frames.map((f) => [f.width, { width: f.width, elements: f.elements, anchors: f.anchors }]),
          ).values(),
        ],
      };
    });
    resize.push({ viewport, ...result });
  }
  const result = { url: targetUrl, browser: await page.context().browser().version(), initial, resize };
  await page.close();
  return result;
}

// Run with a Chromium Playwright CLI session open on rich.html:
// playwright-cli run-code --filename scripts/check-rich-browser.js
// Fixtures and observation hooks affect isolated browser responses, never source files.
async (parentPage) => {
  const results = [];
  const target = parentPage.url().split("/").slice(0, 3).join("/") + "/rich.html";
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  for (const fixture of [false, true]) {
    const page = await parentPage.context().newPage();
    await page.setViewportSize({ width: 1200, height: 900 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(
      (url) => url.pathname === "/src/rich.ts",
      async (route) => {
        const response = await route.fetch();
        let body = await response.text();
        if (!body.includes("const layout = solve(prepared, width);")) throw new Error("Layout hook mismatch");
        body = body.replace(
          "const layout = solve(prepared, width);",
          "const layout = solve(prepared, width, {tracking: window.__qaTracking ?? 0.3}); window.__qaLayout = layout; window.__qaPrepared = prepared;",
        );
        await route.fulfill({ response, body });
      },
    );
    if (fixture)
      await page.route(
        (url) => url.pathname === "/rich.html",
        async (route) => {
          const response = await route.fetch();
          const body = (await response.text()).replace(
            /(<p id="source"[^>]*>)[\s\S]*?(<\/p>)/,
            [
              '$1“<a href="https://example.com/shared">An ',
              "<strong>unusually <em>well-considered</em></strong> <code>inline code</code> link ",
              "carries its reader across many lines of typ<em>ogra</em>phy and keeps its full meaning</a>”, ",
              'while pre<a href="https://example.com/shared"><strong>fixing</strong> another ',
              "<em>independent</em> link with the very same destination and several <u>underlined words</u> ",
              'makes a useful example</a>post. A <span class="accent">colored span</span>, ',
              "punctuation, and Mr.&nbsp;Smith remain intact.$2",
            ].join(""),
          );
          await route.fulfill({ response, body });
        },
      );
    await page.goto(target);
    await page.waitForFunction(() => window.__qaLayout !== undefined);
    const settle = () =>
      page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const states = [];
    for (const viewport of [
      { width: 1200, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      for (const tracking of [0, 0.3, 0.8])
        for (const width of [220, 260, 320, 380, 420, 480, 540]) {
          await page.locator("#width").evaluate(
            (slider, { tracking, width }) => {
              window.__qaTracking = tracking;
              slider.value = String(width);
              slider.dispatchEvent(new Event("input", { bubbles: true }));
            },
            { tracking, width },
          );
          await settle();
          const state = await page.evaluate(() => {
            const root = document.querySelector("#composed");
            const box = root.getBoundingClientRect();
            const lineNodes = [[]];
            for (const element of root.querySelectorAll(".word,.gap,.break")) {
              if (element.classList.contains("break")) lineNodes.push([]);
              else lineNodes.at(-1).push(element);
            }
            const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
            const errors = __qaLayout.lines.map((line, index) => {
              const words = lineNodes[index].filter((node) => node.classList.contains("word"));
              const chars = [...segmenter.segment(words.map((node) => node.textContent).join(""))].length;
              const gaps = line.end - line.start - 1;
              const expectedRight =
                box.left - line.opening + line.natural + gaps * line.wordSpacing + (chars + gaps) * line.tracking;
              return {
                right: words.at(-1).getBoundingClientRect().right - expectedRight,
                left: words[0].getBoundingClientRect().left - (box.left - line.opening),
              };
            });
            const range = document.createRange();
            range.selectNodeContents(root);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
            const data = new DataTransfer();
            root.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
            getSelection().removeAllRanges();
            const sourceLinks = [...document.querySelectorAll("#source a")],
              links = [...root.querySelectorAll("a")];
            return {
              actualWidth: box.width,
              lines: __qaLayout.lines.length,
              maxRightError: Math.max(...errors.map((e) => Math.abs(e.right))),
              maxLeftError: Math.max(...errors.map((e) => Math.abs(e.left))),
              copyExact: data.getData("text/plain") === document.querySelector("#source").textContent,
              sourceLinks: sourceLinks.length,
              renderedLinks: links.length,
              linkTextExact: links.every((link, index) => {
                const clone = link.cloneNode(true);
                clone.querySelectorAll(".generated").forEach((n) => n.remove());
                return clone.textContent === sourceLinks[index].textContent;
              }),
              generatedAriaHidden: [...root.querySelectorAll(".generated")].every(
                (n) => n.getAttribute("aria-hidden") === "true",
              ),
              noOverflow: document.documentElement.scrollWidth <= innerWidth,
            };
          });
          assert(
            state.maxRightError < 0.5 && state.maxLeftError < 0.5,
            `Geometry mismatch: ${JSON.stringify({ fixture, viewport, tracking, width, ...state })}`,
          );
          assert(
            state.copyExact && state.linkTextExact && state.generatedAriaHidden && state.noOverflow,
            `Text or layout regression: ${JSON.stringify({ fixture, viewport, tracking, width, ...state })}`,
          );
          assert(state.sourceLinks === state.renderedLinks, "A source link was split into multiple anchors");
          states.push({ viewport, tracking, width, ...state });
        }
    }
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator("#width").evaluate((slider) => {
      window.__qaTracking = 0.3;
      slider.value = "220";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const cdp = await page.context().newCDPSession(page);
    const tree = await cdp.send("Accessibility.getFullAXTree");
    const axLinkNames = tree.nodes.filter((n) => n.role?.value === "link" && !n.ignored).map((n) => n.name?.value);
    await page.locator("#width").focus();
    const tabOrder = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Tab");
      tabOrder.push(
        await page.evaluate(() => ({
          source: document.activeElement.closest("#source") !== null,
          composed: document.activeElement.closest("#composed") !== null,
          tag: document.activeElement.tagName,
          href: document.activeElement.href,
        })),
      );
    }
    await page.evaluate(() =>
      document.querySelector("#composed").addEventListener("click", (event) => {
        event.preventDefault();
        window.__gapClick = event.target.closest("a")?.href;
      }),
    );
    const gapPoint = await page
      .locator("#composed a")
      .first()
      .evaluate((anchor) => {
        // Line-end source separators have zero width; click a visible gap.
        const gap = [...anchor.querySelectorAll(".gap")].find((gap) => gap.getBoundingClientRect().width > 0);
        if (!gap) throw new Error("Expected a visible space inside the first link");
        const g = gap.getBoundingClientRect();
        const r = [...anchor.getClientRects()].find(
          (r) => r.left <= g.left && r.right >= g.right && r.top <= g.top && r.bottom >= g.top,
        );
        return { x: g.left + g.width / 2, y: r.top + r.height / 2 };
      });
    await page.mouse.click(gapPoint.x, gapPoint.y);
    const gapClick = await page.evaluate(() => window.__gapClick);
    const hover = [];
    for (const index of [0, 1]) {
      await page.locator("#composed a").nth(index).hover();
      hover.push(
        await page.evaluate(() =>
          [...document.querySelectorAll("#composed a")].map((a) => ({
            color: getComputedStyle(a).color,
            rects: a.getClientRects().length,
            href: a.href,
          })),
        ),
      );
    }
    const sourceNames = await page.locator("#source a").allTextContents();
    assert(
      sourceNames.every((name) => axLinkNames.filter((actual) => actual === name).length === 2),
      "Accessible link names differ from source",
    );
    assert(tabOrder[0].composed && tabOrder[1].composed && tabOrder[2].source, "Expected one tab stop per source link");
    assert(gapClick === (await page.locator("#source a").first().getAttribute("href")), "Link gap is not clickable");
    assert(
      hover[0][0].color === hover[1][1].color &&
        hover[0][1].color === hover[1][0].color &&
        hover[0][0].color !== hover[0][1].color,
      "Separate source links must hover independently",
    );
    assert(!errors.length, `Browser errors: ${errors.join("; ")}`);
    results.push({
      fixture: fixture ? "nested marks, mid-word links, duplicate URL" : "demo",
      states: states.length,
      maxRightError: Math.max(...states.map((s) => s.maxRightError)),
      maxLeftError: Math.max(...states.map((s) => s.maxLeftError)),
      sourceLinks: sourceNames.length,
      copy: "exact",
      tabStops: "one per source link",
      accessibleNames: "exact",
      gapClick: "passed",
      independentHover: "passed",
    });
    await page.close();
  }
  return results;
}

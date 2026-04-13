const http = require("http");

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Only handle POST /audit
  if (req.method !== "POST" || !req.url.startsWith("/audit")) {
    res.writeHead(req.url === "/" ? 200 : 404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", message: "POST /audit to run Lighthouse" }));
  }

  // Parse body
  let body = "";
  for await (const chunk of req) body += chunk;

  let parsed;
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid JSON" }));
  }

  const { url, strategy = "mobile" } = parsed;
  if (!url) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Missing url" }));
  }

  try { new URL(url); } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid URL" }));
  }

  let chrome = null;
  try {
    // Dynamic imports for ESM modules
    const { default: lighthouse } = await import("lighthouse");
    const chromeLauncher = await import("chrome-launcher");

    // Launch Chrome
    chrome = await chromeLauncher.launch({
      chromePath: process.env.CHROME_PATH || undefined,
      chromeFlags: ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });

    // Run Lighthouse
    const flags = {
      logLevel: "error",
      output: "json",
      port: chrome.port,
      formFactor: strategy === "mobile" ? "mobile" : "desktop",
      screenEmulation: strategy === "mobile"
        ? { mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false }
        : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
      throttling: strategy === "mobile"
        ? { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 }
        : { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 },
    };

    const result = await lighthouse(url, flags);
    const lhr = JSON.parse(result.report);
    const cats = lhr.categories || {};
    const audits = lhr.audits || {};

    const categories = {
      performance: { score: Math.round((cats.performance?.score || 0) * 100), title: "Performance" },
      accessibility: { score: Math.round((cats.accessibility?.score || 0) * 100), title: "Accessibility" },
      bestPractices: { score: Math.round((cats["best-practices"]?.score || 0) * 100), title: "Best Practices" },
      seo: { score: Math.round((cats.seo?.score || 0) * 100), title: "SEO" },
    };

    const vitalDefs = [
      { id: "largest-contentful-paint", label: "LCP", unit: "s" },
      { id: "first-contentful-paint", label: "FCP", unit: "s" },
      { id: "total-blocking-time", label: "TBT", unit: "ms" },
      { id: "cumulative-layout-shift", label: "CLS", unit: "" },
      { id: "speed-index", label: "SI", unit: "s" },
      { id: "interactive", label: "TTI", unit: "s" },
    ];
    const webVitals = vitalDefs.map((v) => {
      const a = audits[v.id];
      if (!a) return null;
      return {
        id: v.id, label: v.label, value: a.displayValue || "-",
        numericValue: a.numericValue || 0, unit: v.unit,
        score: typeof a.score === "number" ? Math.round(a.score * 100) : 0,
        description: a.description,
      };
    }).filter(Boolean);

    const oppIds = ["render-blocking-resources","unused-css-rules","unused-javascript","modern-image-formats","uses-optimized-images","uses-responsive-images","efficient-animated-content","uses-text-compression","uses-rel-preconnect","server-response-time","redirects","uses-rel-preload","unminified-css","unminified-javascript","dom-size","font-display","third-party-summary"];
    const opportunities = oppIds
      .filter((id) => audits[id] && audits[id].score !== null && audits[id].score < 1)
      .map((id) => {
        const a = audits[id];
        return { id, title: a.title || id, description: (a.description || "").replace(/\[.*?\]\(.*?\)/g, "").trim(), score: typeof a.score === "number" ? Math.round(a.score * 100) : null, displayValue: a.displayValue, numericValue: a.numericValue };
      })
      .sort((a, b) => (a.score ?? 100) - (b.score ?? 100))
      .slice(0, 10);

    const diagIds = ["mainthread-work-breakdown","bootup-time","network-rtt","network-server-latency","total-byte-weight","dom-size","largest-contentful-paint-element","viewport","legacy-javascript","duplicated-javascript"];
    const diagnostics = diagIds
      .filter((id) => audits[id] && audits[id].score !== null && audits[id].score < 1)
      .map((id) => {
        const a = audits[id];
        return { id, title: a.title || id, description: (a.description || "").replace(/\[.*?\]\(.*?\)/g, "").trim(), score: typeof a.score === "number" ? Math.round(a.score * 100) : null, displayValue: a.displayValue };
      })
      .slice(0, 10);

    const passedAudits = Object.entries(audits)
      .filter(([, a]) => a.score === 1)
      .map(([id, a]) => ({ id, title: a.title || id, description: a.description || "", score: 100 }))
      .slice(0, 20);

    const screenshot = audits["final-screenshot"]?.details?.data || "";

    const report = {
      id: `lh-${Date.now()}`, url, strategy,
      timestamp: new Date().toISOString(),
      categories, webVitals, opportunities, diagnostics, passedAudits, screenshot,
      lighthouseVersion: lhr.lighthouseVersion || "",
      fetchTime: lhr.fetchTime || "",
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(report));
  } catch (err) {
    console.error("Lighthouse error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Audit failed" }));
  } finally {
    if (chrome) { try { await chrome.kill(); } catch {} }
  }
});

server.listen(PORT, () => {
  console.log(`Lighthouse server running on port ${PORT}`);
});

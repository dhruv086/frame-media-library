/** Dependency-free Edge/CDP smoke checks. Only this script's own fixture is deleted. */
import { spawn, execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import ffmpegPath from "../../backend/node_modules/ffmpeg-static/index.js";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { loadEnv } from "vite";
import { deflateSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "test-results");
const api = (
  loadEnv("development", root, "VITE_").VITE_API_URL || "http://localhost:4000"
).replace(/\/+$/, "");
const browserPath =
  process.env.BROWSER_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const fixtureName = `frame-smoke-${Date.now()}.png`;
const png = createPng();
let fixtureId;
let videoFixtureId;
let videoFixturePath;
const videoFixtureName = fixtureName.replace('.png', '.mp4');
const extraFixtureNames = [
  `${fixtureName.slice(0, -4)}-a.png`,
  `${fixtureName.slice(0, -4)}-b.png`,
];
let socket;
let browser;
let counter = 0;
const pending = new Map();
const errors = [];
const requests = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function createPng() {
  const width = 640;
  const height = 400;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      const color =
        (x - 460) ** 2 + (y - 105) ** 2 < 2500
          ? [236, 196, 129]
          : y > 310 - x * 0.18
            ? [56, 98, 78]
            : [
                146 + Math.round(y * 0.1),
                181 + Math.round(y * 0.06),
                167 + Math.round(x * 0.04),
              ];
      rows.set(color, offset);
    }
  }
  function chunk(type, data) {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length, 0);
    content.copy(output, 4);
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
    return output;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function apiRequest(path, options) {
  const response = await fetch(`${api}${path}`, {
    ...options,
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message || `API returned ${response.status}`);
  return data;
}

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    );
  return result.result.value;
}

async function waitFor(expression, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function click(selector) {
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
    `button ${selector}`,
  );
  await evaluate(
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element || element.disabled) throw new Error('Missing or disabled: ' + ${JSON.stringify(selector)}); element.click(); })()`,
  );
}

async function clickAsset(selector, name = fixtureName) {
  await evaluate(
    `(() => { const card = Array.from(document.querySelectorAll('.asset-card')).find(card => card.querySelector('h3')?.textContent === ${JSON.stringify(name)}); const button = card?.querySelector(${JSON.stringify(selector)}); if (!button || button.disabled) throw new Error('Missing asset action'); button.click(); })()`,
  );
}

async function fill(selector, value) {
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)})`,
    `input ${selector}`,
  );
  await evaluate(
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing input'); const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
}

async function screenshot(name, width, height) {
  await command("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await sleep(200);
  assert.equal(
    await evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
    true,
    `No horizontal overflow at ${width}px`,
  );
  const result = await command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(resolve(output, name), Buffer.from(result.data, "base64"));
}

try {
  await mkdir(output, { recursive: true });
  const { buckets } = await apiRequest("/buckets");
  assert.ok(buckets.length, "Server has buckets");
  const bucket = buckets[0].name || buckets[0];
  const form = new FormData();
  form.append("bucket", bucket);
  form.append("file", new File([png], fixtureName, { type: "image/png" }));
  const fixture = await apiRequest("/assets", { method: "POST", body: form });
  fixtureId = fixture.id;
  console.log(`Created isolated real-server fixture: ${fixtureName}`);

  browser = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--remote-debugging-port=9222",
      `--user-data-dir=${resolve(root, ".browser-profile")}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  browser.on("error", (error) => errors.push(error.message));
  let target;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(
        "http://127.0.0.1:9222/json/new?about:blank",
        { method: "PUT", signal: AbortSignal.timeout(1000) },
      );
      target = await response.json();
      break;
    } catch {
      await sleep(200);
    }
  }
  assert.ok(target?.webSocketDebuggerUrl, "Headless browser starts");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const task = pending.get(message.id);
      if (task) {
        clearTimeout(task.timer);
        pending.delete(message.id);
        message.error
          ? task.reject(new Error(message.error.message))
          : task.resolve(message.result);
      }
    } else if (message.method === "Runtime.exceptionThrown")
      errors.push(
        message.params.exceptionDetails.exception?.description ||
          message.params.exceptionDetails.text,
      );
    else if (
      message.method === "Log.entryAdded" &&
      message.params.entry.level === "error"
    )
      errors.push(message.params.entry.text);
    else if (message.method === "Network.requestWillBeSent")
      requests.push(message.params.request.url);
  });
  await command("Runtime.enable");
  await command("Log.enable");
  await command("Network.enable");
  await command("Page.enable");
  await command("Page.navigate", { url: "http://localhost:5173" });
  await waitFor(
    `document.querySelector('.asset-card h3')?.textContent === ${JSON.stringify(fixtureName)}`,
    "real asset gallery",
  );
  console.log("PASS: gallery loads real bucket and asset");
  await screenshot("desktop.png", 1440, 1000);
  await screenshot("mobile.png", 390, 844);
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await fill("#search", "definitely-no-matching-frame-asset");
  await waitFor(
    "document.querySelector('.empty-state h3')?.textContent.includes('No assets')",
    "debounced search",
  );
  await click(".empty-state button");
  await waitFor("document.querySelector('.preview-button')", "reset filters");
  console.log("PASS: debounced search and reset");

  await apiRequest(`/assets/${fixture.id}`, {
    method: "PATCH",
    body: JSON.stringify({ altText: "Updated outside the gallery" }),
    headers: { "Content-Type": "application/json" },
  });
  await clickAsset(".preview-button");
  await waitFor(
    "document.querySelector('[role=dialog] img')?.complete",
    "original image preview",
  );
  assert.ok(
    await evaluate(
      "document.querySelector('[role=dialog] img').src.includes('v=1')",
    ),
  );
  assert.equal(
    await evaluate("document.querySelector('[role=dialog] img').alt"),
    "Updated outside the gallery",
  );
  await screenshot("preview.png", 1440, 1000);
  await fill("#variant-width", "200");
  await click(".optimization-footer button");
  await waitFor("document.querySelector('.savings')", "optimized variant blob");
  await waitFor(
    "document.querySelector('.preview-media img')?.naturalWidth === 200",
    "200px optimized output decodes",
  );
  assert.ok(
    await evaluate(
      "document.querySelector('.preview-media img').src.startsWith('blob:')",
    ),
  );
  for (const width of [200, 400]) {
    if (width !== 200) {
      await fill("#variant-width", String(width));
      await waitFor(
        "document.querySelector('.optimization-panel [role=status]')?.textContent.includes('Settings changed')",
        "changed settings require regeneration",
      );
      assert.equal(
        await evaluate("document.querySelector('.preview-media img').naturalWidth"),
        200,
        "Editing settings retains the previous output until submitted",
      );
      await click(".optimization-footer button");
      await waitFor(
        `document.querySelector('.preview-media img')?.naturalWidth === ${width}`,
        `${width}px optimized output decodes`,
      );
    }
    const output = await evaluate(`(() => {
      const image = document.querySelector('.preview-media img');
      const rect = image.getBoundingClientRect();
      const details = Object.fromEntries(Array.from(document.querySelectorAll('.preview-details dl > div')).map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent.trim()]));
      const link = Array.from(document.querySelectorAll('.preview-links a')).find(link => link.textContent.includes('Open optimized'));
      return { width: image.naturalWidth, height: image.naturalHeight, displayedWidth: rect.width, displayedHeight: rect.height, dimensions: details.Dimensions, format: details.Format, link: link?.href, source: image.src };
    })()`);
    assert.equal(output.width, width);
    assert.equal(output.height, width * 400 / 640);
    assert.ok(Math.abs(output.displayedWidth - width) < 1, "Small optimized image is not enlarged");
    assert.ok(Math.abs(output.displayedHeight - output.height) < 1);
    assert.equal(output.dimensions, `${width} × ${output.height} px`);
    assert.equal(output.format, "WEBP");
    assert.equal(output.link, output.source, "Open optimized targets the generated bytes");
    assert.ok(output.link.startsWith("blob:"));
    assert.ok(
      await evaluate(`document.querySelector('.preview-source-label').textContent.includes('${width} × ${output.height} px')`),
    );
  }
  await click(".segmented button:first-child");
  await waitFor(
    "document.querySelector('.preview-media img')?.naturalWidth === 640",
    "original toggle restores original image",
  );
  assert.equal(
    await evaluate("document.querySelector('.preview-details h3').textContent"),
    "Original asset details",
  );
  assert.ok(
    await evaluate("document.querySelector('.preview-details').textContent.includes('640 × 400 px')"),
  );
  await click(".segmented button:last-child");
  await waitFor(
    "document.querySelector('.preview-media img')?.naturalWidth === 400",
    "optimized toggle restores resized image",
  );
  assert.equal(
    await evaluate("document.querySelector('.preview-details h3').textContent"),
    "Optimized details",
  );
  await screenshot("preview-resized.png", 1440, 1000);
  await fill("#variant-width", "1200");
  await click(".optimization-footer button");
  await waitFor(
    "document.querySelector('.preview-media img')?.naturalWidth === 1200",
    "large optimized image decodes",
  );
  await screenshot("preview-resized-mobile.png", 390, 844);
  assert.ok(await evaluate(`(() => {
    const image = document.querySelector('.preview-media img');
    const rect = image.getBoundingClientRect();
    const frame = document.querySelector('.preview-media').getBoundingClientRect();
    return rect.width <= frame.width + 1 && rect.height <= frame.height + 1 && rect.width < image.naturalWidth;
  })()`), "Large image scales down to fit the mobile preview");
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(`(() => {
    const originalFetch = window.fetch;
    window.fetch = (url, options) => {
      if (String(url).includes('/optimized?')) {
        window.fetch = originalFetch;
        return Promise.resolve(new Response(new Blob(['not an image'], { type: 'image/webp' })));
      }
      return originalFetch(url, options);
    };
  })()`);
  await fill("#variant-width", "100");
  await click(".optimization-footer button");
  await waitFor(
    "document.querySelector('.optimization-panel .inline-error')?.textContent.length > 0",
    "invalid optimized bytes produce an error",
  );
  assert.equal(
    await evaluate("document.querySelector('.preview-media img').naturalWidth"),
    1200,
    "A decode failure preserves the previous working preview",
  );
  console.log("PASS: 200px/400px actual preview size, decoded dimensions, view-aware details, optimized link, mobile fit, decode failure recovery");
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await waitFor(
    "!document.querySelector('[role=dialog]')",
    "Escape dismisses preview",
  );
  console.log(
    "PASS: original preview, actual optimized bytes, Escape dismissal",
  );

  await clickAsset('.card-actions button[title="Edit metadata"]');
  await fill("#alt-text", "An isolated frontend smoke test image");
  await fill("#tag-input", "frontend-smoke");
  await command("Runtime.evaluate", {
    expression: "document.querySelector('#tag-input').focus()",
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await waitFor(
    "document.querySelector('.tag')?.textContent.includes('frontend-smoke')",
    "tag chip",
  );
  await click('[role=dialog] button[type="submit"]');
  await waitFor("!document.querySelector('[role=dialog]')", "metadata save");
  const edited = await apiRequest(`/assets/${fixtureId}`);
  assert.equal(edited.altText, "An isolated frontend smoke test image");
  assert.deepEqual(edited.tags, ["frontend-smoke"]);
  console.log("PASS: metadata PATCH and tag chips");

  await waitFor(
    "document.querySelector('.preview-button')",
    "refresh after edit",
  );
  await clickAsset('.card-actions button[title="Replace"]');
  await waitFor(
    "document.querySelector('#replacement')",
    "fresh replacement details",
  );
  await evaluate(
    "(() => { const data = new DataTransfer(); data.items.add(new File(['wrong extension'], 'invalid.jpg', { type: 'image/jpeg' })); const input = document.querySelector('#replacement'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()",
  );
  await waitFor(
    "document.querySelector('#replacement-error')?.textContent.includes('extension must match')",
    "replacement extension validation",
  );
  assert.ok(
    await evaluate(
      "document.querySelector('[role=dialog] button[type=submit]').disabled",
    ),
  );
  await evaluate(
    `(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString("base64"))}), c => c.charCodeAt(0)); const data = new DataTransfer(); data.items.add(new File([bytes], 'replacement.png', { type: 'image/png' })); const input = document.querySelector('#replacement'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await click('[role=dialog] button[type="submit"]');
  await waitFor(
    "document.querySelector('.success-panel')",
    "replacement completes",
  );
  assert.equal(
    await evaluate("document.querySelector('#same-url').value"),
    fixture.url,
  );
  await click('[aria-label="Close dialog"]');
  await waitFor(
    "document.querySelector('.asset-card .version')?.textContent === 'v2'",
    "gallery version bump",
  );
  assert.ok(
    await evaluate(
      "document.querySelector('.asset-thumbnail img').src.includes('v=2')",
    ),
  );
  console.log(
    "PASS: replacement extension check, stable URL, v2 thumbnail cache bust",
  );

  await click(".header-actions > button");
  await evaluate(
    "(() => { const data = new DataTransfer(); data.items.add(new File(['bad'], 'unsupported.svg', { type: 'image/svg+xml' })); const input = document.querySelector('input[type=file]'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()",
  );
  await waitFor(
    "document.querySelector('.upload-invalid .inline-error')?.textContent.includes('Unsupported')",
    "upload validation",
  );
  await screenshot("upload-mobile.png", 390, 844);
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    `(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(png.toString("base64"))}), c => c.charCodeAt(0)); const data = new DataTransfer(); for (const name of ${JSON.stringify([fixtureName, ...extraFixtureNames])}) data.items.add(new File([bytes], name, { type: 'image/png' })); const input = document.querySelector('input[type=file]'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await click(".modal-footer .primary");
  await waitFor(
    "document.querySelectorAll('.upload-success').length === 2 && document.querySelectorAll('.upload-error').length === 1",
    "multiple upload results",
    30000,
  );
  assert.ok(
    await evaluate(
      "document.querySelector('.upload-error .inline-error').textContent.includes('already exists')",
    ),
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.upload-success [aria-valuenow=\"100\"]').length",
    ),
    2,
  );
  await click('[aria-label="Close dialog"]');
  console.log(
    "PASS: upload validation, multiple XHR uploads, progress, duplicate server message, mobile modal layout",
  );

  await waitFor(
    "document.querySelector('.preview-button')",
    "gallery after uploads",
  );
  await clickAsset('.card-actions button[title="Delete"]');
  await waitFor(
    "document.querySelector('.delete-description')",
    "delete confirmation",
  );
  await click("[role=dialog] .danger");
  await waitFor("!document.querySelector('[role=dialog]')", "fixture deletion");
  fixtureId = null;
  videoFixturePath = resolve(output, videoFixtureName);
  await promisify(execFile)(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.2', '-c:v', 'libx264', '-crf', '10', '-c:a', 'aac', '-pix_fmt', 'yuv420p', videoFixturePath], { windowsHide: true });
  const videoForm = new FormData();
  videoForm.append('bucket', bucket);
  videoForm.append('file', new File([await readFile(videoFixturePath)], videoFixtureName, { type: 'video/mp4' }));
  const videoAsset = await apiRequest('/assets', { method: 'POST', body: videoForm });
  videoFixtureId = videoAsset.id;
  await command('Page.reload');
  await waitFor(`document.querySelector('.asset-card h3')?.textContent === ${JSON.stringify(videoFixtureName)}`, 'video gallery fixture');
  await clickAsset('.preview-button', videoFixtureName);
  await waitFor("document.querySelector('.preview-media video')?.videoWidth === 1280", 'original video metadata');
  for (const codec of ['h264', 'vp9']) {
    await evaluate(`(() => {
      const resolution = document.querySelector('#video-resolution');
      resolution.value = '480'; resolution.dispatchEvent(new Event('change', { bubbles: true }));
      const codec = document.querySelector('#video-codec');
      codec.value = ${JSON.stringify(codec)}; codec.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await fill('#video-bitrate', '500');
    await fill('#video-crf', '32');
    await click('.video-optimization-panel button[type=submit]');
    await waitFor(`Array.from(document.querySelectorAll('.video-variant')).some(item => item.textContent.includes('${codec.toUpperCase()}'))`, `${codec} persisted video variant`, 45000);
    await waitFor(`document.querySelector('.preview-media video')?.videoHeight <= 480 && document.querySelector('.preview-media video')?.videoHeight > 0 && document.querySelector('.preview-source-label').textContent.includes('${codec.toUpperCase()}')`, `${codec} optimized playback metadata`);
    const optimizedVideo = await evaluate(`(() => {
      const video = document.querySelector('.preview-media video');
      const link = Array.from(document.querySelectorAll('.preview-links a')).find(link => link.textContent.includes('Open optimized'));
      return { width: video.videoWidth, height: video.videoHeight, source: video.src, link: link.href, details: document.querySelector('.preview-details').textContent };
    })()`);
    assert.ok(optimizedVideo.width <= 854 && optimizedVideo.height <= 480);
    assert.equal(optimizedVideo.link, optimizedVideo.source);
    assert.ok(optimizedVideo.source.endsWith(codec === 'h264' ? '.mp4' : '.webm'));
    assert.ok(optimizedVideo.details.includes(`${optimizedVideo.width} × ${optimizedVideo.height} px`));
    assert.ok(await evaluate("(async () => { const video = document.querySelector('.preview-media video'); video.muted = true; await video.play(); return !video.paused; })()"), 'Optimized video plays');
    await waitFor("document.querySelector('.preview-media video').currentTime > 0.1", 'optimized video frame playback');
    await evaluate("document.querySelector('.preview-media video').pause()");
  }
  await screenshot('video-optimized-desktop.png', 1440, 1000);
  await screenshot('video-optimized-mobile.png', 390, 844);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await click('.segmented button:first-child');
  await waitFor("document.querySelector('.preview-media video')?.videoWidth === 1280", 'original video toggle');
  await click('.segmented button:last-child');
  await waitFor("document.querySelector('.preview-media video')?.videoHeight <= 480", 'optimized video toggle');
  await click('[aria-label="Close dialog"]');
  await clickAsset('.preview-button', videoFixtureName);
  await waitFor("document.querySelectorAll('.video-variant').length === 2", 'saved variants survive reopening');
  await click('.video-variant:last-child');
  await waitFor("document.querySelector('.preview-source-label').textContent.includes('VP9')", 'saved VP9 preview');
  await click('[aria-label="Close dialog"]');
  await clickAsset('.card-actions button[title="Edit metadata"]', videoFixtureName);
  await fill('#alt-text', 'Optimized video with audio');
  await fill('#tag-input', 'video-optimized');
  await fill('#expiry', '2027-12-31');
  await click('[role=dialog] button[type=submit]');
  await waitFor("!document.querySelector('[role=dialog]')", 'video metadata save');
  const videoEdited = await apiRequest(`/assets/${videoFixtureId}`);
  assert.equal(videoEdited.altText, 'Optimized video with audio');
  assert.deepEqual(videoEdited.tags, ['video-optimized']);
  assert.equal(videoEdited.expiresAt, '2027-12-31T23:59:59.999Z');
  assert.equal(videoEdited.variants.filter(item => item.status === 'ready').length, 2);
  await apiRequest(`/assets/${videoFixtureId}`, { method: 'DELETE' });
  videoFixtureId = null;
  console.log('PASS: video controls, H.264/VP9 encoding and playback, measured details, optimized links, mobile layout, saved variants, alt/tags/expiry UI');
  await sleep(300);
  const unexpected = errors.filter(
    (error) => !error.includes("409 (Conflict)"),
  );
  assert.deepEqual(unexpected, [], "No unexpected browser console errors");
  assert.ok(
    requests.includes(`${api}/api/health`),
    "Header checks backend health",
  );
  assert.ok(
    requests.includes(`${api}/assets/${fixture.id}`),
    "Asset actions fetch current backend details",
  );
  console.log(
    `PASS: confirmed deletion; no unexpected console errors; ${requests.length} browser requests observed`,
  );
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.error(`FAIL: ${error.stack}`);
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      console.error(await evaluate("document.body.innerText"));
      await screenshot("failure.png", 1440, 1000);
    } catch {}
  }
  process.exitCode = 1;
} finally {
  if (videoFixtureId) {
    try { await apiRequest(`/assets/${videoFixtureId}`, { method: 'DELETE' }); }
    catch (error) { console.error(`Video fixture cleanup needed: ${videoFixtureId}: ${error.message}`); }
  }
  if (videoFixturePath) await rm(videoFixturePath, { force: true });
  if (fixtureId) {
    try {
      await apiRequest(`/assets/${fixtureId}`, { method: "DELETE" });
      console.log("Cleaned up this run’s fixture.");
    } catch (error) {
      console.error(`Fixture cleanup needed: ${fixtureId}: ${error.message}`);
    }
  }
  try {
    const { buckets } = await apiRequest("/buckets");
    const { assets } = await apiRequest(
      `/assets?${new URLSearchParams({ bucket: buckets[0].name || buckets[0], limit: "100" })}`,
    );
    for (const asset of assets.filter((asset) =>
      extraFixtureNames.includes(asset.originalName),
    ))
      await apiRequest(`/assets/${asset.id}`, { method: "DELETE" });
  } catch (error) {
    console.error(`Extra fixture cleanup failed: ${error.message}`);
  }
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(new Error("Browser closed"));
  }
  socket?.close();
  browser?.kill();
}

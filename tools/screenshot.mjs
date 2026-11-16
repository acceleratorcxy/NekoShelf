// 用本机 Edge（headless + CDP）给运行中的 NekoShelf 截图，用于交付说明/移动端适配验收。
//
// 用法：
//   node tools/screenshot.mjs <baseUrl> <outDir> <username> <password> [flags] [routes...]
//
// flags:
//   --width=390 --height=844   视口尺寸（默认 1440x900）
//   --dpr=3                    设备像素比（默认 1）
//   --mobile                   移动设备模拟（mobile:true + touch + 粗指针）
//   --touch                    只开触摸模拟（平板/触屏桌面）
//   --input=touch|mouse|auto   预置前端交互模式（写 localStorage，验证触摸/鼠标两套行为）
//   --label=390x844            输出文件名前缀，便于同一目录区分视口
//   --full-page                截整页（captureBeyondViewport）
//   --audit                    额外输出横向溢出 / 触控目标审计的 JSON 行（前缀 AUDIT ）
//   --wait=4000                等待页面就绪的上限毫秒（默认 5000）
//   --settle=600               就绪后再等多久（默认 500ms，等字体/过渡）
//   --no-login                 不写 sid Cookie（测未登录页面）
//   --click=<css>              截图前点一次该元素（如 .reader__mode 里选模式）
//   --click-text=<文字>        截图前点一次文字匹配的按钮/选项（如 双页）
//   --click-at=x,y             截图前在视口坐标处点一下（验证阅读器左/中/右点击分区）
//   --storage=<key>=<json>     页面脚本执行前写入 localStorage（可重复，用于预置阅读偏好）
//   --probe=<js 表达式>        截图前在页面里求值并打印 PROBE 行（验证状态/行为）
//   --keys=<a,b,Enter>         截图前依次派发按键（验证键盘翻页）
//   --swipe=x1,y1,x2,y2        截图前派发一次触摸滑动（验证滑动手势翻页）
//
// 例：
//   node tools/screenshot.mjs http://127.0.0.1:18090 "$TMP/neko-shots/mobile" admin testpass123 \
//     --width=390 --height=844 --dpr=3 --mobile --audit --label=390x844 / /works/3 /reader/3
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
const boolFlags = new Set(["mobile", "touch", "full-page", "audit", "no-login"]);
for (const arg of argv) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq === -1 ? true : arg.slice(eq + 1);
    flags.set(name, value);
  } else {
    positional.push(arg);
  }
}
for (const name of boolFlags) if (flags.has(name) && flags.get(name) !== true) fail(`--${name} 不接受值`);

const [baseUrl, outDir, username, password] = positional;
if (!baseUrl || !outDir) fail("usage: node tools/screenshot.mjs <baseUrl> <outDir> [username] [password] [flags] [routes...]");

const width = Number(flags.get("width") ?? 1440);
const height = Number(flags.get("height") ?? 900);
const dpr = Number(flags.get("dpr") ?? 1);
const mobile = flags.get("mobile") === true;
const touch = mobile || flags.get("touch") === true;
const fullPage = flags.get("full-page") === true;
const audit = flags.get("audit") === true;
const waitMs = Number(flags.get("wait") ?? 5000);
const settleMs = Number(flags.get("settle") ?? 500);
const label = flags.get("label");
const noLogin = flags.get("no-login") === true;
// 交互动作（截图前执行一次）：--click=<css> / --click-text=<按钮文字> / --click-at=x,y
const clickSelector = flags.get("click");
const clickText = flags.get("click-text");
const clickAt = flags.get("click-at");
// --hover-at=x,y：鼠标模式悬停态（验证 hover 提示/光标）
const hoverAt = flags.get("hover-at");
// --storage=key=<json>：预置 localStorage（可重复）
const storageEntries = [];
const storageArgPrefix = "--storage=";
for (const arg of argv) {
  if (arg.startsWith(storageArgPrefix)) storageEntries.push(arg.slice(storageArgPrefix.length));
}
// --probe=<js>：截图前在页面里求值并打印结果
const probeExpr = flags.get("probe");
// --keys=a,b,Enter：依次派发按键
const keysArg = flags.get("keys");
// --swipe=x1,y1,x2,y2：派发一次触摸滑动
const swipeArg = flags.get("swipe");
const inputMode = flags.get("input") ?? "auto";
if (!["auto", "touch", "mouse"].includes(inputMode)) {
  fail("--input 只支持 auto / touch / mouse");
}
if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) fail("--width/--height 不合法");

const allPositionalRoutes = positional.slice(4);
const routes = allPositionalRoutes.length ? allPositionalRoutes : ["/"];
console.log(`plan: ${baseUrl} -> ${outDir} @ ${width}x${height} dpr${dpr}${mobile ? " mobile" : ""} routes=${JSON.stringify(routes)}`);

await mkdir(outDir, { recursive: true });

// 1) 登录拿 sid
let sid;
if (!noLogin) {
  if (!username || !password) fail("需要 username/password（或用 --no-login 跳过）");
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!loginRes.ok) fail(`login failed: ${loginRes.status}`);
  const setCookie = loginRes.headers.getSetCookie?.() ?? [];
  sid = setCookie.map((c) => /^sid=([^;]+)/.exec(c)?.[1]).find(Boolean);
  if (!sid) fail("no sid cookie in login response");
}

// 2) 起 Edge（窗口尺寸兜底；真实视口由 Emulation 决定）
// 每次用独立 user-data-dir；端口交给浏览器自己挑（--remote-debugging-port=0 +
// DevToolsActivePort 文件），避免并发/残留实例抢到同一个端口导致连错浏览器。
const userDataDir = path.join(process.env.TEMP ?? ".", `neko-edge-profile-${process.pid}`);
await mkdir(userDataDir, { recursive: true });
const devtoolsHost = "localhost";
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    `--window-size=${Math.max(width, 400)},${Math.max(height, 300)}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const portFile = path.join(userDataDir, "DevToolsActivePort");
const deadline = Date.now() + 25_000;
let port = 0;
while (Date.now() < deadline) {
  try {
    const first = (await readFile(portFile, "utf8")).split("\n")[0]?.trim() ?? "";
    if (/^\d+$/.test(first)) {
      port = Number(first);
      break;
    }
  } catch {
    // 端口文件还没写出来
  }
  await sleep(150);
}
if (!port) fail("edge devtools port not found");

let target;
while (Date.now() < deadline) {
  try {
    const list = await (await fetch(`http://${devtoolsHost}:${port}/json/list`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {
    // 端口未就绪
  }
  await sleep(250);
}
if (!target) fail("edge devtools not reachable");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
let msgId = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "exception");
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    pageErrors.push(msg.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails)}`);
  return res.result?.value;
};

await send("Page.enable");
await send("Network.enable");
await send("Runtime.enable");
if (flags.get("errors") === true) {
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__nekoErrors = []; window.addEventListener("error", (e) => window.__nekoErrors.push(String(e.message || e.error))); window.addEventListener("unhandledrejection", (e) => window.__nekoErrors.push("rejection: " + String(e.reason))); (function(){const orig=console.error;console.error=function(...a){window.__nekoErrors.push("console.error: "+a.map(String).join(" "));return orig.apply(console,a);};})();`,
  });
}
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: dpr,
  mobile,
  screenWidth: width,
  screenHeight: height,
  screenOrientation: { type: width >= height ? "landscapePrimary" : "portraitPrimary", angle: width >= height ? 90 : 0 },
});
await send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
if (sid) await send("Network.setCookie", { name: "sid", value: sid, url: baseUrl, httpOnly: true });
// 交互模式：在页面脚本前写入 localStorage，让前端首帧就是指定模式
if (inputMode !== "auto") {
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("nekoshelf.interaction-mode", ${JSON.stringify(inputMode)}); } catch (error) {}`,
  });
}
// 其它 localStorage 预置项：--storage=key=<json>
if (storageEntries.length > 0) {
  const lines = [];
  for (const entry of storageEntries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) fail(`--storage 参数不合法：${entry}（应为 key=<json>）`);
    const key = entry.slice(0, eq);
    const raw = entry.slice(eq + 1);
    // 目标：localStorage 里存的是字符串。能解析成 JSON 就按 JSON 文本存，否则按原文存。
    let valueLiteral;
    try {
      valueLiteral = JSON.stringify(JSON.stringify(JSON.parse(raw)));
    } catch {
      valueLiteral = JSON.stringify(raw);
    }
    lines.push(`localStorage.setItem(${JSON.stringify(key)}, ${valueLiteral});`);
  }
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { ${lines.join(" ")} } catch (error) {}`,
  });
}

// 判定页面就绪：DOM 完成 + 图片解码完成 + React 已挂载出内容
const READY_EXPR = `(() => {
  if (document.readyState !== "complete") return false;
  const root = document.getElementById("root");
  if (!root || root.childElementCount === 0) return false;
  const imgs = Array.from(document.images);
  return imgs.every((img) => img.complete);
})()`;

const AUDIT_EXPR = `(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const de = document.documentElement;
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    return s;
  };
  const inScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
      p = p.parentElement;
    }
    return false;
  };
  const overflow = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    if (r.right <= vw + 0.5 && r.left >= -0.5) continue;
    if (inScroller(el)) continue;
    overflow.push({ sel: sel(el), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
    if (overflow.length >= 12) break;
  }
  const small = [];
  const inputMode = document.documentElement.dataset.input ?? "unknown";
  const minTarget = inputMode === "touch" ? 44 : 28;
  const controls = document.body.querySelectorAll(
    "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=switch], [role=tab], [role=radio], label.checkbox"
  );
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1) continue;
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    if (el.matches("input[type=checkbox], input[type=radio]")) {
      // 勾选框本身很小，但外层 label 才是真正的触控目标
      const label = el.closest("label");
      if (label) {
        const lr = label.getBoundingClientRect();
        if (lr.width >= minTarget && lr.height >= minTarget) continue;
      }
    }
    if (r.width >= minTarget && r.height >= minTarget) continue;
    small.push({ sel: sel(el), w: Math.round(r.width), h: Math.round(r.height) });
  }
  small.sort((a, b) => a.w * a.h - b.w * b.h);
  const imgs = Array.from(document.images).filter((i) => i.getBoundingClientRect().width > 1);
  // 懒加载/尚未解码的图不算损坏：只有「已加载完成但解码失败」才是真坏图
  const pendingImgs = imgs.filter((i) => !i.complete).length;
  const brokenImgs = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => sel(i) + " " + (i.currentSrc || i.src));
  return {
    url: location.pathname + location.search,
    viewport: { w: vw, h: vh, dpr: window.devicePixelRatio },
    inputMode,
    interactionPref: document.documentElement.dataset.inputPref ?? null,
    smallTargetMin: minTarget,
    docScrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    hOverflow: de.scrollWidth > vw + 1,
    scrollableMain: (() => { const m = document.querySelector(".app-main"); return m ? { scrollW: m.scrollWidth, clientW: m.clientWidth } : null; })(),
    overflow: overflow.slice(0, 6),
    layout: {
      clientW: de.clientWidth,
      innerW: window.innerWidth,
      mq: {
        w430: matchMedia("(max-width: 430px)").matches,
        w768: matchMedia("(min-width: 768px)").matches,
        w1000: matchMedia("(min-width: 1000px)").matches,
        w1024: matchMedia("(min-width: 1024px)").matches,
        w1240: matchMedia("(min-width: 1240px)").matches,
      },
      workGridCols: (() => {
        const g = document.querySelector(".work-grid");
        return g ? getComputedStyle(g).gridTemplateColumns.split(" ").length : null;
      })(),
      workDetailCols: (() => {
        const g = document.querySelector(".work-detail");
        return g ? getComputedStyle(g).gridTemplateColumns.split(" ").length : null;
      })(),
      headerH: document.querySelector(".app-header")?.getBoundingClientRect().height ?? null,
    },
    smallTargetCount: small.length,
    smallTargets: small.slice(0, 10),
    imageCount: imgs.length,
    pendingImgs,
    brokenImgs: brokenImgs.slice(0, 4),
  };
})()`;

const KEY_CODES = {
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  Space: { key: " ", code: "Space", vk: 32 },
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
};
for (const letter of "abcdefghijklmnopqrstuvwxyz") {
  const upper = letter.toUpperCase();
  KEY_CODES[upper] = { key: letter, code: `Key${upper}`, vk: upper.charCodeAt(0) };
}

async function dispatchKey(token) {
  const parts = token.split("+");
  const name = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    if (part === "Shift") modifiers |= 8;
    else if (part === "Control" || part === "Ctrl") modifiers |= 2;
    else if (part === "Alt") modifiers |= 1;
    else if (part === "Meta") modifiers |= 4;
    else throw new Error(`未知修饰键 ${part}`);
  }
  // 允许直接写字母/小写
  const info = KEY_CODES[name] ?? KEY_CODES[name.toUpperCase?.()] ?? null;
  if (!info) throw new Error(`未知按键 ${name}`);
  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
    modifiers,
  };
  await send("Input.dispatchKeyEvent", {
    type: info.key.length === 1 ? "keyDown" : "rawKeyDown",
    ...base,
    text: info.key.length === 1 ? info.key : undefined,
  });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(140);
}

async function dispatchSwipe(x1, y1, x2, y2) {
  const steps = 6;
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] });
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    await send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x1 + (x2 - x1) * ratio, y: y1 + (y2 - y1) * ratio }],
    });
    await sleep(16);
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(200);
}

const auditResults = [];
for (const route of routes) {
  const slug = route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "index";
  const out = path.join(outDir, `${label ? label + "_" : ""}${slug}.png`);
  await send("Page.navigate", { url: `${baseUrl}${route}` });
  const readyDeadline = Date.now() + waitMs;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try {
      if (await evaluate(READY_EXPR)) {
        ready = true;
        break;
      }
    } catch {
      // 页面切换中，忽略
    }
    await sleep(150);
  }
  await sleep(settleMs);
  // 可选：先执行一次交互再截图（验证双页降级、点击翻页、模式切换等）
  if (clickSelector || clickText || clickAt) {
    if (clickSelector) {
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(clickSelector)}); if (!el) return false; el.click(); return true; })()`);
    }
    if (clickText) {
      await evaluate(`(() => {
        const text = ${JSON.stringify(clickText)};
        const nodes = document.querySelectorAll("button, [role=radio], [role=button], [role=tab], a");
        const el = [...nodes].find((n) => (n.textContent || "").trim().includes(text));
        if (!el) return false;
        el.click();
        return true;
      })()`);
    }
    if (clickAt) {
      const [cx, cy] = String(clickAt).split(",").map(Number);
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send("Input.dispatchMouseEvent", { type, x: cx, y: cy, button: "left", clickCount: 1 });
        }
      }
    }
    await sleep(Math.max(settleMs, 800));
  }
  if (hoverAt) {
    const [hx, hy] = String(hoverAt).split(",").map(Number);
    if (Number.isFinite(hx) && Number.isFinite(hy)) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hx, y: hy });
      await sleep(500);
    }
  }
  // 键盘 / 滑动 / 探针（放在点击之后，用于验证交互后的状态）
  if (keysArg) {
    const tokens = String(keysArg).split(",").map((item) => item.trim()).filter(Boolean);
    for (const token of tokens) {
      try {
        await dispatchKey(token);
      } catch (err) {
        console.log(`KEY_ERROR ${JSON.stringify({ route, token, error: String(err) })}`);
      }
    }
    await sleep(260);
  }
  if (swipeArg) {
    const [sx1, sy1, sx2, sy2] = String(swipeArg).split(",").map(Number);
    if ([sx1, sy1, sx2, sy2].every((value) => Number.isFinite(value))) {
      await dispatchSwipe(sx1, sy1, sx2, sy2);
    }
  }
  if (probeExpr) {
    try {
      const value = await evaluate(String(probeExpr));
      console.log(`PROBE ${JSON.stringify({ route, value })}`);
    } catch (err) {
      console.log(`PROBE ${JSON.stringify({ route, error: String(err) })}`);
    }
  }
  if (audit) {
    try {
      const result = await evaluate(AUDIT_EXPR);
      auditResults.push(result);
      console.log(`AUDIT ${JSON.stringify(result)}`);
    } catch (err) {
      console.log(`AUDIT ${JSON.stringify({ route, error: String(err) })}`);
    }
  }
  const shotParams = { format: "png" };
  if (fullPage) {
    const metrics = await send("Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize;
    shotParams.captureBeyondViewport = true;
    shotParams.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
  }
  const shot = await send("Page.captureScreenshot", shotParams);
  await writeFile(out, Buffer.from(shot.data, "base64"));
  if (flags.get("errors") === true) {
    try {
      const captured = await evaluate("JSON.stringify(window.__nekoErrors ?? [])");
      console.log(`CAPTURED-ERRORS ${captured}`);
    } catch {
      // ignore
    }
  }
  console.log(`saved ${out} (${width}x${height} dpr${dpr}${mobile ? " mobile" : ""}${touch ? " touch" : ""}${ready ? "" : " NOT-READY"})`);
}

if (audit) {
  const summary = {
    viewport: `${width}x${height}`,
    dpr,
    mobile,
    touch,
    pages: auditResults.length,
    hOverflowPages: auditResults.filter((r) => r.hOverflow).map((r) => r.url),
    smallTargetPages: auditResults.filter((r) => (r.smallTargetCount ?? 0) > 0).map((r) => `${r.url}:${r.smallTargetCount}`),
    brokenImages: auditResults.filter((r) => (r.brokenImgs?.length ?? 0) > 0).map((r) => `${r.url}:${r.brokenImgs.length}`),
  };
  console.log(`AUDIT_SUMMARY ${JSON.stringify(summary)}`);
  const reportPath = path.join(outDir, `${label ? label + "_" : ""}audit.json`);
  await writeFile(reportPath, JSON.stringify({ width, height, dpr, mobile, touch, results: auditResults }, null, 2));
  console.log(`saved ${reportPath}`);
}

ws.close();
// 用 PID 树结束整棵 Edge 进程（不要按镜像名杀，会连带用户自己的浏览器）
try {
  spawnSync("taskkill", ["/pid", String(edge.pid), "/t", "/f"], { stdio: "ignore" });
} catch {
  edge.kill();
}
try {
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // 临时 profile 清理失败不影响结果
}
process.exit(0);

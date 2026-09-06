import chalk from "chalk";
import readline from "readline";
import { config } from "../../core/config.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        path.resolve(__dirname, "..", "..", "..", "package.json"),
        "utf-8",
      ),
    );
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

const BRAND = "#663fe0";
const BRAND_LIGHT = "#8b6ce7";
const ACCENT = "#00d4aa";
const _SURFACE = "#1a1a2e";
const SURFACE_LIGHT = "#252540";
const TEXT_PRIMARY = "#e0e0ff";
const TEXT_MUTED = "#6b6b8d";
const SUCCESS = "#00d4aa";
const WARNING = "#ffb347";
const ERROR = "#ff6b6b";

const LOGO_LINES = [
  chalk.white(" ██████╗ ██╗    ██╗███████╗███╗   ██╗") +
    chalk.hex("#663fe0")("██████╗ ██████╗  ██████╗ ██╗  ██╗██╗   ██╗"),
  chalk.white("██╔═══██╗██║    ██║██╔════╝████╗  ██║") +
    chalk.hex("#663fe0")("██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝╚██╗ ██╔╝"),
  chalk.white("██║   ██║██║ █╗ ██║█████╗  ██╔██╗ ██║") +
    chalk.hex("#663fe0")("██████╔╝██████╔╝██║   ██║ ╚███╔╝  ╚████╔╝ "),
  chalk.white("██║▄▄ ██║██║███╗██║██╔══╝  ██║╚██╗██║") +
    chalk.hex("#663fe0")("██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗   ╚██╔╝  "),
  chalk.white("╚██████╔╝╚███╔███╔╝███████╗██║ ╚████║") +
    chalk.hex("#663fe0")("██║     ██║  ██║╚██████╔╝██╔╝ ██╗   ██║   "),
  chalk.white(" ╚══▀▀═╝  ╚══╝╚══╝ ╚══════╝╚═╝  ╚═══╝") +
    chalk.hex("#663fe0")("╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   "),
];

const SPINNER_FRAMES = [
  "\u280B",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283C",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280F",
];

type View = "menu" | "overview" | "accounts" | "streams" | "sessions" | "logs";

interface LogEntry {
  id: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: string;
}

interface AccountInfo {
  id: string;
  email: string;
  cooldown: number;
  cooldownReason: string | null;
  activeLoad: number;
  ready: boolean;
  streams: number;
}

interface StreamInfo {
  key: string;
  accountId: string;
  uiSessionId: string;
  ageMs: number;
}

interface SessionInfo {
  sessionKey: string;
  chatId: string;
  accountId: string;
  historyComplete: boolean;
  updatedAt: number;
  ttlRemaining: number;
}

interface OverviewData {
  uptime: number;
  requestsTotal: number;
  requestsCompletions: number;
  requestsErrors: number;
  requestsSuccessRate: number;
  latency?: { sum: number; count: number };
  latencyCompletion?: { sum: number; count: number };
  memory: { rss: number; systemTotal: number; pct: number };
  cpu?: { cores: number; load1m: number };
  activeStreamsMetric: number;
  sessionCount: number;
  accounts: AccountInfo[];
  inUseAccounts: string[];
  watchdog?: { overall: number; ram: number };
  maxStreamsPerAccount?: number;
  readyAccountCount?: number;
  warmPool: Record<string, number>;
}

interface Toast {
  message: string;
  type: "success" | "error" | "info";
  expiresAt: number;
}

export async function tuiCommand(options: { port: number }): Promise<void> {
  const baseUrl = `http://localhost:${options.port}`;
  const views: View[] = [
    "menu",
    "overview",
    "accounts",
    "streams",
    "sessions",
    "logs",
  ];
  let currentView: View = "menu";
  let running = true;
  let connected = false;
  let selectedIndex = 0;
  let scrollOffset = 0;
  let autoFollow = true;
  let levelFilter: string = "all";
  let searchQuery = "";
  let searchActive = false;
  let searchBuffer = "";
  let spinnerFrame = 0;
  let toasts: Toast[] = [];
  let _polling = false;

  let overview: OverviewData | null = null;
  let accounts: AccountInfo[] = [];
  let inUseAccounts: string[] = [];
  let maxStreamsPerAccount = 2;
  let streams: StreamInfo[] = [];
  let sessions: SessionInfo[] = [];
  let logs: LogEntry[] = [];
  let lastLogId = 0;
  let authRequired = false;

  let cookieHeader = "";
  let adminAuthed = false;
  let adminEnabled = true;
  let authAttempted = false;

  let cols = process.stdout.columns || 80;
  let rows = process.stdout.rows || 24;

  if (!process.stdin.isTTY) {
    console.log(
      'TUI requires an interactive terminal. Use "qwenproxy status" or "qwenproxy logs --follow" instead.',
    );
    return;
  }

  const _origLog = console.log;
  const _origError = console.error;
  const _origWarn = console.warn;
  const _origInfo = console.info;
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  console.info = () => {};

  process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[?25l");
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  function cleanup() {
    running = false;
    console.log = _origLog;
    console.error = _origError;
    console.warn = _origWarn;
    console.info = _origInfo;
    process.stdin.setRawMode(false);
    process.stdin.removeAllListeners("keypress");
    process.stdout.write("\x1b[?25h");
    process.stdout.write("\x1b[?1049l");
  }

  function ansiWidth(s: string): number {
    return s.replace(
      new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"),
      "",
    ).length;
  }

  function truncate(s: string, max: number): string {
    if (ansiWidth(s) <= max) return s;
    let t = s;
    while (t.length > 0 && ansiWidth(t) > max - 1) t = t.slice(0, -1);
    return t + "\u2026";
  }

  function padRight(s: string, len: number): string {
    const diff = len - ansiWidth(s);
    return diff > 0 ? s + " ".repeat(diff) : s;
  }

  function centerText(s: string, w: number): string {
    const len = ansiWidth(s);
    const pad = Math.max(0, Math.floor((w - len) / 2));
    return " ".repeat(pad) + s + " ".repeat(Math.max(0, w - pad - len));
  }

  function progressBar(
    pct: number,
    width: number,
    filledColor: string,
    emptyColor: string,
  ): string {
    const clampedPct = Math.max(0, Math.min(100, pct));
    const filled = Math.round((clampedPct / 100) * width);
    const empty = width - filled;
    return (
      chalk.hex(filledColor)("\u2588".repeat(filled)) +
      chalk.hex(emptyColor)("\u2591".repeat(empty))
    );
  }

  function boxTop(
    w: number,
    style: "heavy" | "light" | "rounded" = "rounded",
  ): string {
    if (style === "heavy")
      return "\u250F" + "\u2501".repeat(Math.max(0, w - 2)) + "\u2513";
    if (style === "rounded")
      return "\u256D" + "\u2500".repeat(Math.max(0, w - 2)) + "\u256E";
    return "\u250C" + "\u2500".repeat(Math.max(0, w - 2)) + "\u2510";
  }

  function boxBot(
    w: number,
    style: "heavy" | "light" | "rounded" = "rounded",
  ): string {
    if (style === "heavy")
      return "\u2517" + "\u2501".repeat(Math.max(0, w - 2)) + "\u251B";
    if (style === "rounded")
      return "\u2570" + "\u2500".repeat(Math.max(0, w - 2)) + "\u256F";
    return "\u2514" + "\u2500".repeat(Math.max(0, w - 2)) + "\u2518";
  }

  function boxLine(
    content: string,
    w: number,
    align: "left" | "center" | "right" = "left",
    borderColor?: string,
  ): string {
    const inner = w - 2;
    const visible = truncate(content, inner);
    const len = ansiWidth(visible);
    let leftPad = 0;
    if (align === "center")
      leftPad = Math.max(0, Math.floor((inner - len) / 2));
    else if (align === "right") leftPad = Math.max(0, inner - len);
    const rightPad = Math.max(0, inner - leftPad - len);
    const bc = borderColor ? chalk.hex(borderColor) : chalk.hex(SURFACE_LIGHT);
    return (
      bc("\u2502") +
      " ".repeat(leftPad) +
      visible +
      " ".repeat(rightPad) +
      bc("\u2502")
    );
  }

  function showToast(
    message: string,
    type: "success" | "error" | "info" = "info",
  ) {
    toasts.push({ message, type, expiresAt: Date.now() + 3000 });
  }

  function getSpinner(): string {
    return chalk.hex(BRAND)(
      SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length],
    );
  }

  async function api(apiPath: string, init?: RequestInit): Promise<any | null> {
    try {
      const headers = new Headers(init?.headers);
      if (cookieHeader) headers.set("Cookie", cookieHeader);

      const res = await fetch(`${baseUrl}${apiPath}`, {
        ...init,
        headers,
      });

      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const parts = setCookie.split(",");
        for (const part of parts) {
          if (part.trim().startsWith("qadmin=")) {
            cookieHeader = part.trim().split(";")[0];
            adminAuthed = true;
            break;
          }
        }
      }

      if (res.status === 401) {
        authRequired = true;
        connected = true;
        if (!authAttempted) {
          authAttempted = true;
          await authenticate();
        }
        return null;
      }

      authRequired = false;
      connected = true;
      if (!res.ok) return null;
      return await res.json();
    } catch {
      connected = false;
      return null;
    }
  }

  async function authenticate(): Promise<boolean> {
    if (!adminEnabled) return false;

    const session = await api("/admin/api/session");
    if (!session) return false;

    if (!session.enabled) {
      adminEnabled = false;
      return false;
    }

    if (session.authenticated) {
      adminAuthed = true;
      return true;
    }

    const password = config.adminPassword || "";
    if (!password) return false;

    try {
      const res = await fetch(`${baseUrl}/admin/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) return false;

      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const parts = setCookie.split(",");
        for (const part of parts) {
          if (part.trim().startsWith("qadmin=")) {
            cookieHeader = part.trim().split(";")[0];
            adminAuthed = true;
            return true;
          }
        }
      }
    } catch {
      void 0;
    }

    return false;
  }

  async function pollOverview() {
    const d = await api("/admin/api/overview");
    if (d) {
      overview = d;
      accounts = d.accounts || [];
      inUseAccounts = d.inUseAccounts || [];
      maxStreamsPerAccount = d.maxStreamsPerAccount || 2;
    }
  }

  async function pollAccounts() {
    const d = await api("/admin/api/accounts");
    if (d) {
      accounts = d.accounts || [];
      inUseAccounts = d.inUse || [];
      maxStreamsPerAccount = d.maxStreamsPerAccount || 2;
    }
  }

  async function pollStreams() {
    const d = await api("/admin/api/streams");
    if (d) streams = d.streams || [];
  }

  async function pollSessions() {
    const d = await api("/admin/api/sessions");
    if (d) sessions = Array.isArray(d) ? d : [];
  }

  async function pollLogs() {
    const d = await api(
      `/admin/api/logs${lastLogId ? `?since=${lastLogId}` : ""}`,
    );
    if (d && Array.isArray(d)) {
      for (const e of d) {
        logs.push(e);
        if (e.id > lastLogId) lastLogId = e.id;
      }
      if (logs.length > 1000) logs = logs.slice(-1000);
    }
  }

  async function poll() {
    _polling = true;
    await pollOverview();
    switch (currentView) {
      case "menu":
        break;
      case "overview":
        break;
      case "accounts":
        break;
      case "streams":
        await pollStreams();
        break;
      case "sessions":
        await pollSessions();
        break;
      case "logs":
        await pollLogs();
        break;
    }
    _polling = false;
  }

  function fmtBytes(n: number): string {
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }

  function fmtSec(s: number): string {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }

  function fmtUptime(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  function timeAgo(ts: number): string {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 86400)}d ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function renderLogo(width: number): string[] {
    const maxW = Math.max(20, width - 4);
    return LOGO_LINES.map((line) => {
      const lineW = ansiWidth(line);
      if (lineW > maxW) {
        let t = line;
        while (t.length > 0 && ansiWidth(t) > maxW - 1) t = t.slice(0, -1);
        return " ".repeat(2) + t + "\u2026";
      }
      const pad = Math.max(0, Math.floor((maxW - lineW) / 2));
      return " ".repeat(2 + pad) + line;
    });
  }

  function renderHeader(): string[] {
    const w = cols;
    const lines: string[] = [];
    const version = getVersion();
    const clock = new Date().toLocaleTimeString();
    const browser = config.browser.type;
    const accountCount = overview ? String(overview.accounts.length) : "--";

    if (currentView === "menu" && overview) {
      lines.push(chalk.hex(SURFACE_LIGHT)("\u2501".repeat(w)));
      lines.push(...renderLogo(w));
      lines.push("");
      const tagline = chalk.hex(BRAND)(`v${version}`);
      lines.push(centerText(tagline, w));
      lines.push("");

      const statsW = Math.min(w - 4, 72);
      const pad = Math.max(0, Math.floor((w - statsW) / 2));
      const sp = " ".repeat(pad);

      lines.push(sp + boxTop(statsW, "rounded"));

      const statusBadge = connected
        ? chalk.bgHex(SUCCESS).black.bold(" ONLINE ")
        : chalk.bgHex(ERROR).white.bold(" OFFLINE ");
      const uptimeStr = chalk.hex(TEXT_PRIMARY)(fmtUptime(overview.uptime));
      const line1 = `  ${statusBadge}  ${chalk.hex(TEXT_MUTED)("Uptime")} ${uptimeStr}   ${chalk.hex(TEXT_MUTED)("Browser")} ${chalk.hex(TEXT_PRIMARY)(browser)}`;
      lines.push(sp + boxLine(line1, statsW, "left", SURFACE_LIGHT));

      const successColor =
        overview.requestsSuccessRate >= 99
          ? SUCCESS
          : overview.requestsSuccessRate >= 95
            ? WARNING
            : ERROR;
      const line2 = `  ${chalk.hex(TEXT_MUTED)("Requests")} ${chalk.hex(TEXT_PRIMARY)(String(overview.requestsTotal))}   ${chalk.hex(TEXT_MUTED)("Success")} ${chalk.hex(successColor)(overview.requestsSuccessRate.toFixed(1) + "%")}   ${chalk.hex(TEXT_MUTED)("Errors")} ${chalk.hex(overview.requestsErrors > 0 ? ERROR : SUCCESS)(String(overview.requestsErrors))}`;
      lines.push(sp + boxLine(line2, statsW, "left", SURFACE_LIGHT));

      const line3 = `  ${chalk.hex(TEXT_MUTED)("Streams")} ${chalk.hex(ACCENT)(String(overview.activeStreamsMetric))}   ${chalk.hex(TEXT_MUTED)("Sessions")} ${chalk.hex(ACCENT)(String(overview.sessionCount))}   ${chalk.hex(TEXT_MUTED)("Accounts")} ${chalk.hex(TEXT_PRIMARY)(`${overview.accounts.length}`)} ${chalk.hex(TEXT_MUTED)("(")} ${chalk.hex(SUCCESS)(`${overview.readyAccountCount ?? 0} ready`)}${chalk.hex(TEXT_MUTED)(")")}`;
      lines.push(sp + boxLine(line3, statsW, "left", SURFACE_LIGHT));

      lines.push(sp + boxBot(statsW, "rounded"));
      lines.push("");
    } else if (currentView === "menu") {
      lines.push(chalk.hex(SURFACE_LIGHT)("\u2501".repeat(w)));
      lines.push(...renderLogo(w));
      lines.push("");
      const tagline = chalk.hex(BRAND)(`v${version}`);
      lines.push(centerText(tagline, w));
      lines.push("");

      const loadingW = Math.min(w - 4, 40);
      const pad = Math.max(0, Math.floor((w - loadingW) / 2));
      const sp = " ".repeat(pad);
      lines.push(sp + boxTop(loadingW, "rounded"));
      const loadLine = `  ${getSpinner()} ${chalk.hex(WARNING)("Connecting to server...")}`;
      lines.push(sp + boxLine(loadLine, loadingW, "center", SURFACE_LIGHT));
      lines.push(sp + boxBot(loadingW, "rounded"));
      lines.push("");
    } else {
      const headerW = w;
      const statusDot = connected
        ? chalk.hex(SUCCESS)("\u25CF")
        : chalk.hex(ERROR)("\u25CF");
      const statusText = connected
        ? chalk.hex(SUCCESS)("connected")
        : chalk.hex(ERROR)("offline");
      const authBadge = authRequired
        ? chalk.bgHex(ERROR).white.bold(" AUTH REQUIRED ")
        : adminAuthed
          ? chalk.bgHex(SUCCESS).black.bold(" AUTHED ")
          : "";

      const topLine = `  ${chalk.hex(BRAND).bold("QwenProxy")} ${chalk.hex(TEXT_MUTED)(`v${version}`)}  ${chalk.hex(SURFACE_LIGHT)("\u2502")}  ${chalk.hex(TEXT_MUTED)(`Port ${options.port}`)}  ${chalk.hex(SURFACE_LIGHT)("\u2502")}  ${chalk.hex(TEXT_MUTED)(`[${browser}]`)}  ${chalk.hex(SURFACE_LIGHT)("\u2502")}  ${chalk.hex(TEXT_MUTED)(`${accountCount} accounts`)}`;
      lines.push(topLine);
      const botLine = `  ${statusDot} ${statusText}  ${chalk.hex(TEXT_MUTED)(clock)}  ${authBadge}`;
      lines.push(botLine);

      if (!adminEnabled && adminAuthed === false && authAttempted) {
        lines.push(
          `  ${chalk.bgHex(ERROR).white.bold(" ! ")} ${chalk.hex(ERROR)("Admin disabled \u2014 set ADMIN_PASSWORD in .env")}`,
        );
      }

      if (connected && overview) {
        const memBar = progressBar(
          overview.memory.pct,
          15,
          overview.memory.pct > 80
            ? ERROR
            : overview.memory.pct > 60
              ? WARNING
              : ACCENT,
          SURFACE_LIGHT,
        );
        const summaryParts = [
          `${chalk.hex(TEXT_MUTED)("Up")} ${chalk.hex(TEXT_PRIMARY)(fmtUptime(overview.uptime))}`,
          `${chalk.hex(TEXT_MUTED)("St")} ${chalk.hex(ACCENT)(String(overview.activeStreamsMetric))}`,
          `${chalk.hex(TEXT_MUTED)("Se")} ${chalk.hex(ACCENT)(String(overview.sessionCount))}`,
          `${chalk.hex(TEXT_MUTED)("Req")} ${chalk.hex(TEXT_PRIMARY)(String(overview.requestsTotal))}`,
          `${chalk.hex(TEXT_MUTED)("Mem")} ${memBar} ${chalk.hex(TEXT_PRIMARY)(`${overview.memory.pct}%`)}`,
        ];
        lines.push(
          `  ${summaryParts.join(chalk.hex(SURFACE_LIGHT)(" \u2502 "))}`,
        );
      }

      lines.push(chalk.hex(SURFACE_LIGHT)("\u2500".repeat(headerW)));
    }

    return lines;
  }

  function renderTabs(): string[] {
    const w = cols;
    const tabItems = views.filter((v) => v !== "menu");
    const labels = tabItems.map((v) => {
      const label = v.charAt(0).toUpperCase() + v.slice(1);
      if (v === currentView) {
        return chalk.hex(BRAND).bold(` \u258D ${label} `);
      }
      return chalk.hex(TEXT_MUTED)(`   ${label} `);
    });
    const tabStr = labels.join(chalk.hex(SURFACE_LIGHT)("\u2502"));
    const padded = ansiWidth(tabStr) < w - 4 ? "  " + tabStr : tabStr;
    return [padded, chalk.hex(SURFACE_LIGHT)("\u2500".repeat(w))];
  }

  function renderMenu(h: number, w: number): string[] {
    const l: string[] = [];
    const items = [
      {
        icon: "\u25A3",
        label: "Overview",
        desc: "Server status, metrics & stats",
        key: "1",
      },
      {
        icon: "\u25A3",
        label: "Accounts",
        desc: "Manage proxy accounts",
        key: "2",
      },
      {
        icon: "\u25A3",
        label: "Streams",
        desc: "Active request streams",
        key: "3",
      },
      {
        icon: "\u25A3",
        label: "Sessions",
        desc: "Chat sessions & history",
        key: "4",
      },
      { icon: "\u25A3", label: "Logs", desc: "Real-time log viewer", key: "5" },
    ];

    const boxW = Math.min(w - 4, 52);
    const pad = Math.max(0, Math.floor((w - boxW) / 2));
    const sp = " ".repeat(pad);

    l.push(sp + boxTop(boxW, "heavy"));
    l.push(
      sp +
        boxLine(
          chalk.hex(BRAND).bold("  Navigation"),
          boxW,
          "left",
          SURFACE_LIGHT,
        ),
    );
    l.push(sp + boxLine("", boxW, "left", SURFACE_LIGHT));

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isSel = i === selectedIndex;
      const selIndicator = isSel
        ? chalk.bgHex(BRAND).white.bold(" \u25B6 ")
        : chalk.hex(SURFACE_LIGHT)("   ");
      const icon = isSel
        ? chalk.hex(ACCENT)(item.icon)
        : chalk.hex(TEXT_MUTED)(item.icon);
      const label = isSel
        ? chalk.hex(TEXT_PRIMARY).bold(item.label)
        : chalk.hex(TEXT_PRIMARY)(item.label);
      const desc = chalk.hex(TEXT_MUTED)(item.desc);
      const keyHint = chalk.hex(BRAND_LIGHT)(`[${item.key}]`);

      const content = ` ${selIndicator} ${icon} ${padRight(label, 12)} ${desc}`;
      const fullContent =
        content +
        " ".repeat(
          Math.max(0, boxW - 4 - ansiWidth(content) - ansiWidth(keyHint) - 1),
        ) +
        keyHint +
        " ";
      l.push(
        sp + boxLine(fullContent, boxW, "left", isSel ? BRAND : SURFACE_LIGHT),
      );
    }

    l.push(sp + boxLine("", boxW, "left", SURFACE_LIGHT));
    l.push(sp + boxBot(boxW, "heavy"));
    return l;
  }

  function renderStatCard(
    title: string,
    value: string,
    subtitle: string,
    w: number,
    color: string,
  ): string[] {
    const lines: string[] = [];
    lines.push(boxTop(w, "rounded"));
    lines.push(
      boxLine(` ${chalk.hex(TEXT_MUTED)(title)}`, w, "left", SURFACE_LIGHT),
    );
    lines.push(
      boxLine(` ${chalk.hex(color).bold(value)}`, w, "left", SURFACE_LIGHT),
    );
    lines.push(
      boxLine(` ${chalk.hex(TEXT_MUTED)(subtitle)}`, w, "left", SURFACE_LIGHT),
    );
    lines.push(boxBot(w, "rounded"));
    return lines;
  }

  function renderOverview(h: number, _w: number): string[] {
    if (!overview)
      return [
        "",
        `  ${getSpinner()} ${chalk.hex(WARNING)("Waiting for data...")}`,
      ];
    const o = overview;
    const l: string[] = [""];

    const cardW = Math.min(Math.floor((_w - 8) / 3), 24);
    const totalCardsW = cardW * 3 + 4;
    const pad = Math.max(0, Math.floor((_w - totalCardsW) / 2));
    const sp = " ".repeat(pad);

    const c1 = renderStatCard(
      "REQUESTS",
      String(o.requestsTotal),
      `Completions: ${o.requestsCompletions}`,
      cardW,
      ACCENT,
    );
    const c2 = renderStatCard(
      "SUCCESS RATE",
      `${o.requestsSuccessRate.toFixed(1)}%`,
      `Errors: ${o.requestsErrors}`,
      cardW,
      o.requestsSuccessRate >= 99
        ? SUCCESS
        : o.requestsSuccessRate >= 95
          ? WARNING
          : ERROR,
    );
    const c3 = renderStatCard(
      "STREAMS",
      String(o.activeStreamsMetric),
      `Sessions: ${o.sessionCount}`,
      cardW,
      ACCENT,
    );

    for (let row = 0; row < c1.length; row++) {
      l.push(`${sp}${c1[row]}  ${c2[row]}  ${c3[row]}`);
    }

    l.push("");

    const detailW = Math.min(_w - 4, 74);
    const dpad = Math.max(0, Math.floor((_w - detailW) / 2));
    const dsp = " ".repeat(dpad);

    l.push(dsp + boxTop(detailW, "rounded"));
    l.push(
      dsp +
        boxLine(
          chalk.hex(BRAND).bold(" Performance"),
          detailW,
          "left",
          SURFACE_LIGHT,
        ),
    );
    l.push(dsp + boxLine("", detailW, "left", SURFACE_LIGHT));

    if (o.latencyCompletion?.count) {
      const avgLat = Math.round(
        o.latencyCompletion.sum / o.latencyCompletion.count,
      );
      const latColor =
        avgLat < 1000 ? SUCCESS : avgLat < 3000 ? WARNING : ERROR;
      l.push(
        dsp +
          boxLine(
            `  ${padRight(chalk.hex(TEXT_MUTED)("Avg Latency"), 20)} ${chalk.hex(latColor)(`${avgLat}ms`)}`,
            detailW,
            "left",
            SURFACE_LIGHT,
          ),
      );
    }
    if (o.latency?.count) {
      l.push(
        dsp +
          boxLine(
            `  ${padRight(chalk.hex(TEXT_MUTED)("Overall Latency"), 20)} ${chalk.hex(TEXT_PRIMARY)(`${Math.round(o.latency.sum / o.latency.count)}ms`)}`,
            detailW,
            "left",
            SURFACE_LIGHT,
          ),
      );
    }

    const memColor =
      o.memory.pct > 80 ? ERROR : o.memory.pct > 60 ? WARNING : ACCENT;
    const memBar = progressBar(o.memory.pct, 20, memColor, SURFACE_LIGHT);
    l.push(
      dsp +
        boxLine(
          `  ${padRight(chalk.hex(TEXT_MUTED)("Memory"), 20)} ${memBar} ${chalk.hex(memColor)(`${o.memory.pct}%`)} ${chalk.hex(TEXT_MUTED)(`(${fmtBytes(o.memory.rss)})`)}`,
          detailW,
          "left",
          SURFACE_LIGHT,
        ),
    );

    if (o.cpu) {
      const loadPct = Math.min(100, (o.cpu.load1m / o.cpu.cores) * 100);
      const cpuColor = loadPct > 80 ? ERROR : loadPct > 60 ? WARNING : ACCENT;
      const cpuBar = progressBar(loadPct, 20, cpuColor, SURFACE_LIGHT);
      l.push(
        dsp +
          boxLine(
            `  ${padRight(chalk.hex(TEXT_MUTED)("CPU Load"), 20)} ${cpuBar} ${chalk.hex(cpuColor)(o.cpu.load1m.toFixed(2))} ${chalk.hex(TEXT_MUTED)(`(${o.cpu.cores} cores)`)}`,
            detailW,
            "left",
            SURFACE_LIGHT,
          ),
      );
    }

    if (o.watchdog) {
      const wdStatus =
        o.watchdog.overall === 0
          ? chalk.bgHex(SUCCESS).black.bold(" HEALTHY ")
          : o.watchdog.overall === 1
            ? chalk.bgHex(WARNING).black.bold(" DEGRADED ")
            : chalk.bgHex(ERROR).white.bold(" CRITICAL ");
      l.push(
        dsp +
          boxLine(
            `  ${padRight(chalk.hex(TEXT_MUTED)("Watchdog"), 20)} ${wdStatus}`,
            detailW,
            "left",
            SURFACE_LIGHT,
          ),
      );
    }

    l.push(dsp + boxBot(detailW, "rounded"));
    l.push("");

    l.push(
      dsp +
        chalk
          .hex(BRAND)
          .bold(
            ` Accounts (${o.accounts.length} total, ${o.readyAccountCount ?? 0} ready, ${o.inUseAccounts.length} in use)`,
          ),
    );

    if (o.accounts.length > 0) {
      const tableW = Math.min(detailW, 74);
      l.push(dsp + boxTop(tableW, "rounded"));

      const hdr = `  ${padRight(chalk.hex(TEXT_MUTED).bold("Email"), 30)} ${padRight(chalk.hex(TEXT_MUTED).bold("Status"), 18)} ${padRight(chalk.hex(TEXT_MUTED).bold("Load"), 8)} ${chalk.hex(TEXT_MUTED).bold("Streams")}`;
      l.push(dsp + boxLine(hdr, tableW, "left", SURFACE_LIGHT));
      l.push(
        dsp +
          boxLine(
            chalk.hex(SURFACE_LIGHT)("  " + "\u2500".repeat(tableW - 4)),
            tableW,
            "left",
            SURFACE_LIGHT,
          ),
      );

      const maxShow = Math.min(o.accounts.length, h - l.length - 4);
      for (let i = 0; i < maxShow; i++) {
        const a = o.accounts[i];
        let statusBadge: string;
        if (a.cooldown > 0) {
          statusBadge = chalk
            .bgHex(WARNING)
            .black(` CD ${fmtSec(Math.floor(a.cooldown / 1000))} `);
        } else if (a.ready) {
          statusBadge = chalk.bgHex(SUCCESS).black(" ONLINE ");
        } else {
          statusBadge = chalk.bgHex(WARNING).black(" WARMING ");
        }

        const loadStr = `${a.activeLoad}/${maxStreamsPerAccount}`;
        const loadColor =
          a.activeLoad >= maxStreamsPerAccount
            ? ERROR
            : a.activeLoad > 0
              ? WARNING
              : TEXT_MUTED;
        const row = `  ${padRight(truncate(a.email, 28), 30)} ${padRight(statusBadge, 22)} ${padRight(chalk.hex(loadColor)(loadStr), 12)} ${chalk.hex(ACCENT)(String(a.streams))}`;
        l.push(dsp + boxLine(row, tableW, "left", SURFACE_LIGHT));
      }

      if (o.accounts.length > maxShow) {
        l.push(
          dsp +
            boxLine(
              chalk.hex(TEXT_MUTED)(
                `  ... and ${o.accounts.length - maxShow} more`,
              ),
              tableW,
              "left",
              SURFACE_LIGHT,
            ),
        );
      }

      l.push(dsp + boxBot(tableW, "rounded"));
    }

    return l;
  }

  function renderAccounts(h: number, _w: number): string[] {
    if (accounts.length === 0)
      return ["", `  ${chalk.hex(WARNING)("No accounts configured.")}`];
    const l: string[] = [""];

    const tableW = Math.min(_w - 4, 80);
    const pad = Math.max(0, Math.floor((_w - tableW) / 2));
    const sp = " ".repeat(pad);

    l.push(sp + boxTop(tableW, "rounded"));
    const hdr = `  ${padRight(chalk.hex(TEXT_MUTED).bold("Email"), 32)} ${padRight(chalk.hex(TEXT_MUTED).bold("Status"), 22)} ${padRight(chalk.hex(TEXT_MUTED).bold("Load"), 8)} ${padRight(chalk.hex(TEXT_MUTED).bold("Streams"), 9)} ${chalk.hex(TEXT_MUTED).bold("In Use")}`;
    l.push(sp + boxLine(hdr, tableW, "left", SURFACE_LIGHT));
    l.push(
      sp +
        boxLine(
          chalk.hex(SURFACE_LIGHT)("  " + "\u2500".repeat(tableW - 4)),
          tableW,
          "left",
          SURFACE_LIGHT,
        ),
    );

    const maxShow = Math.min(accounts.length, h - 6);
    const startIdx = Math.max(
      0,
      Math.min(selectedIndex - maxShow + 1, accounts.length - maxShow),
    );

    for (
      let i = startIdx;
      i < Math.min(accounts.length, startIdx + maxShow);
      i++
    ) {
      const a = accounts[i];
      const isSel = i === selectedIndex;
      const selMark = isSel ? chalk.bgHex(BRAND).white(" \u25B6 ") : "    ";

      let statusBadge: string;
      if (a.cooldown > 0) {
        const cdText = `CD ${fmtSec(Math.floor(a.cooldown / 1000))}`;
        statusBadge = chalk.bgHex(WARNING).black(` ${cdText} `);
        if (a.cooldownReason)
          statusBadge += chalk.hex(TEXT_MUTED)(
            ` ${truncate(a.cooldownReason, 10)}`,
          );
      } else if (a.ready) {
        statusBadge = chalk.bgHex(SUCCESS).black(" ONLINE ");
      } else {
        statusBadge = chalk.bgHex(WARNING).black(" WARMING ");
      }

      const inUse = inUseAccounts.includes(a.id)
        ? chalk.bgHex(ACCENT).black(" YES ")
        : chalk.hex(TEXT_MUTED)(" no ");

      const loadStr = `${a.activeLoad}/${maxStreamsPerAccount}`;
      const loadColor =
        a.activeLoad >= maxStreamsPerAccount
          ? ERROR
          : a.activeLoad > 0
            ? WARNING
            : TEXT_MUTED;

      const emailDisplay = isSel
        ? chalk.hex(TEXT_PRIMARY).bold(truncate(a.email, 28))
        : truncate(a.email, 28);
      const row = `${selMark}${padRight(emailDisplay, 32)} ${padRight(statusBadge, 24)} ${padRight(chalk.hex(loadColor)(loadStr), 10)} ${padRight(chalk.hex(ACCENT)(String(a.streams)), 11)} ${inUse}`;
      l.push(sp + boxLine(row, tableW, "left", isSel ? BRAND : SURFACE_LIGHT));
    }

    if (accounts.length > maxShow) {
      const scrollInfo = chalk.hex(TEXT_MUTED)(
        `  Showing ${startIdx + 1}-${Math.min(startIdx + maxShow, accounts.length)} of ${accounts.length}`,
      );
      l.push(sp + boxLine(scrollInfo, tableW, "left", SURFACE_LIGHT));
    }

    l.push(sp + boxBot(tableW, "rounded"));

    if (selectedIndex < accounts.length && accounts[selectedIndex]) {
      const a = accounts[selectedIndex];
      l.push("");
      l.push(
        sp +
          chalk.hex(BRAND).bold("\u25B8 Selected: ") +
          chalk.hex(TEXT_PRIMARY)(a.email) +
          chalk.hex(TEXT_MUTED)(` (id: ${a.id})`),
      );
    }

    return l;
  }

  function renderStreams(h: number, _w: number): string[] {
    if (streams.length === 0)
      return ["", `  ${chalk.hex(TEXT_MUTED)("No active streams.")}`];
    const l: string[] = [""];

    const tableW = Math.min(_w - 4, 60);
    const pad = Math.max(0, Math.floor((_w - tableW) / 2));
    const sp = " ".repeat(pad);

    l.push(sp + boxTop(tableW, "rounded"));
    const hdr = `  ${padRight(chalk.hex(TEXT_MUTED).bold("Account"), 18)} ${padRight(chalk.hex(TEXT_MUTED).bold("Session"), 22)} ${chalk.hex(TEXT_MUTED).bold("Age")}`;
    l.push(sp + boxLine(hdr, tableW, "left", SURFACE_LIGHT));
    l.push(
      sp +
        boxLine(
          chalk.hex(SURFACE_LIGHT)("  " + "\u2500".repeat(tableW - 4)),
          tableW,
          "left",
          SURFACE_LIGHT,
        ),
    );

    const maxShow = Math.min(streams.length, h - 6);
    for (let i = 0; i < maxShow; i++) {
      const s = streams[i];
      const isSel = i === selectedIndex;
      const selMark = isSel ? chalk.bgHex(BRAND).white(" \u25B6 ") : "    ";
      const ageColor = s.ageMs > 60000 ? WARNING : TEXT_PRIMARY;
      const row = `${selMark}${padRight(truncate(s.accountId, 14), 18)} ${padRight(truncate(s.uiSessionId, 18), 22)} ${chalk.hex(ageColor)(fmtSec(Math.floor(s.ageMs / 1000)))}`;
      l.push(sp + boxLine(row, tableW, "left", isSel ? BRAND : SURFACE_LIGHT));
    }

    if (streams.length > maxShow) {
      l.push(
        sp +
          boxLine(
            chalk.hex(TEXT_MUTED)(`  ... and ${streams.length - maxShow} more`),
            tableW,
            "left",
            SURFACE_LIGHT,
          ),
      );
    }

    l.push(sp + boxBot(tableW, "rounded"));
    return l;
  }

  function renderSessions(h: number, _w: number): string[] {
    if (sessions.length === 0)
      return ["", `  ${chalk.hex(TEXT_MUTED)("No active sessions.")}`];
    const l: string[] = [""];

    const tableW = Math.min(_w - 4, 78);
    const pad = Math.max(0, Math.floor((_w - tableW) / 2));
    const sp = " ".repeat(pad);

    l.push(sp + boxTop(tableW, "rounded"));
    const hdr = `  ${padRight(chalk.hex(TEXT_MUTED).bold("Session Key"), 18)} ${padRight(chalk.hex(TEXT_MUTED).bold("Chat"), 14)} ${padRight(chalk.hex(TEXT_MUTED).bold("Account"), 14)} ${padRight(chalk.hex(TEXT_MUTED).bold("History"), 9)} ${padRight(chalk.hex(TEXT_MUTED).bold("TTL"), 7)} ${chalk.hex(TEXT_MUTED).bold("Updated")}`;
    l.push(sp + boxLine(hdr, tableW, "left", SURFACE_LIGHT));
    l.push(
      sp +
        boxLine(
          chalk.hex(SURFACE_LIGHT)("  " + "\u2500".repeat(tableW - 4)),
          tableW,
          "left",
          SURFACE_LIGHT,
        ),
    );

    const maxShow = Math.min(sessions.length, h - 6);
    for (let i = 0; i < maxShow; i++) {
      const s = sessions[i];
      const isSel = i === selectedIndex;
      const selMark = isSel ? chalk.bgHex(BRAND).white(" \u25B6 ") : "    ";
      const histBadge = s.historyComplete
        ? chalk.bgHex(SUCCESS).black(" FULL ")
        : chalk.bgHex(WARNING).black(" BOOT ");
      const row = `${selMark}${padRight(truncate(s.sessionKey, 14), 18)} ${padRight(truncate(s.chatId, 10), 14)} ${padRight(truncate(s.accountId, 10), 14)} ${padRight(histBadge, 13)} ${padRight(chalk.hex(TEXT_PRIMARY)(fmtSec(s.ttlRemaining)), 9)} ${chalk.hex(TEXT_MUTED)(timeAgo(s.updatedAt))}`;
      l.push(sp + boxLine(row, tableW, "left", isSel ? BRAND : SURFACE_LIGHT));
    }

    if (sessions.length > maxShow) {
      l.push(
        sp +
          boxLine(
            chalk.hex(TEXT_MUTED)(
              `  ... and ${sessions.length - maxShow} more`,
            ),
            tableW,
            "left",
            SURFACE_LIGHT,
          ),
      );
    }

    l.push(sp + boxBot(tableW, "rounded"));
    return l;
  }

  function renderLogs(h: number, w: number): string[] {
    let filtered = logs;
    if (levelFilter !== "all")
      filtered = filtered.filter((e) => e.level === levelFilter);
    if (searchQuery)
      filtered = filtered.filter((e) =>
        e.message.toLowerCase().includes(searchQuery.toLowerCase()),
      );

    const l: string[] = [""];

    const filterLabel =
      levelFilter !== "all"
        ? chalk.bgHex(BRAND).white(` ${levelFilter.toUpperCase()} `)
        : "";
    const searchLabel = searchQuery
      ? chalk.bgHex("#ff6b9d").white(` /"${searchQuery}" `)
      : "";
    const followLabel = autoFollow
      ? chalk.bgHex(SUCCESS).black(" FOLLOWING ")
      : chalk.bgHex(WARNING).black(" PAUSED ");
    const countLabel = chalk.hex(TEXT_MUTED)(`(${filtered.length} entries)`);

    l.push(
      `  ${chalk.hex(BRAND).bold("Logs")} ${countLabel} ${filterLabel} ${searchLabel} ${followLabel}`,
    );
    l.push(
      chalk.hex(SURFACE_LIGHT)("  " + "\u2500".repeat(Math.min(w - 4, 76))),
    );

    const maxShow = Math.max(1, h - 5);
    let visible: LogEntry[];
    if (autoFollow) {
      visible = filtered.slice(-maxShow);
    } else {
      visible = filtered.slice(scrollOffset, scrollOffset + maxShow);
    }

    for (const e of visible) {
      const time = new Date(e.timestamp).toTimeString().slice(0, 8);
      let lvlBadge: string;
      switch (e.level) {
        case "error":
          lvlBadge = chalk.bgHex(ERROR).white.bold(" ERR ");
          break;
        case "warn":
          lvlBadge = chalk.bgHex(WARNING).black.bold(" WRN ");
          break;
        case "debug":
          lvlBadge = chalk.bgHex(SURFACE_LIGHT).hex(TEXT_MUTED)(" DBG ");
          break;
        default:
          lvlBadge = chalk.bgHex(ACCENT).black.bold(" INF ");
          break;
      }
      const ctx = e.context ? chalk.hex(BRAND_LIGHT)(`[${e.context}]`) : "";
      const msgColor =
        e.level === "error"
          ? ERROR
          : e.level === "warn"
            ? WARNING
            : TEXT_PRIMARY;
      const msg = truncate(e.message, w - 32);
      l.push(
        `  ${chalk.hex(TEXT_MUTED)(time)} ${lvlBadge} ${ctx} ${chalk.hex(msgColor)(msg)}`,
      );
    }

    if (visible.length === 0)
      l.push(`  ${chalk.hex(TEXT_MUTED)("No log entries matching filters.")}`);

    if (!autoFollow && filtered.length > maxShow) {
      const pct = Math.round(
        (scrollOffset / (filtered.length - maxShow)) * 100,
      );
      l.push(
        chalk.hex(SURFACE_LIGHT)("  " + "\u2500".repeat(Math.min(w - 4, 76))),
      );
      l.push(
        `  ${chalk.hex(TEXT_MUTED)(`Scroll: ${pct}% (${scrollOffset + 1}-${Math.min(scrollOffset + maxShow, filtered.length)} of ${filtered.length})`)}`,
      );
    }

    return l;
  }

  function renderToast(): string | null {
    toasts = toasts.filter((t) => t.expiresAt > Date.now());
    if (toasts.length === 0) return null;
    const t = toasts[toasts.length - 1];
    const bgColor =
      t.type === "success" ? SUCCESS : t.type === "error" ? ERROR : BRAND;
    return chalk.bgHex(bgColor).white.bold(` ${t.message} `);
  }

  function renderFooter(): string {
    const sep = chalk.hex(SURFACE_LIGHT)(" \u2502 ");
    const keyStyle = (k: string) =>
      chalk.bgHex(SURFACE_LIGHT).hex(TEXT_PRIMARY)(` ${k} `);

    switch (currentView) {
      case "menu":
        return [
          keyStyle("\u2191\u2193"),
          chalk.hex(TEXT_MUTED)("navigate"),
          sep,
          keyStyle("Enter"),
          chalk.hex(TEXT_MUTED)("select"),
          sep,
          keyStyle("q"),
          chalk.hex(TEXT_MUTED)("quit"),
        ].join("");
      case "overview":
        return [
          keyStyle("1-5"),
          chalk.hex(TEXT_MUTED)("views"),
          sep,
          keyStyle("Tab"),
          chalk.hex(TEXT_MUTED)("next"),
          sep,
          keyStyle("q"),
          chalk.hex(TEXT_MUTED)("quit"),
        ].join("");
      case "accounts":
        return [
          keyStyle("\u2191\u2193"),
          chalk.hex(TEXT_MUTED)("select"),
          sep,
          keyStyle("c"),
          chalk.hex(TEXT_MUTED)("clear cooldown"),
          sep,
          keyStyle("Tab"),
          chalk.hex(TEXT_MUTED)("next"),
          sep,
          keyStyle("q"),
          chalk.hex(TEXT_MUTED)("quit"),
        ].join("");
      case "streams":
        return [
          keyStyle("\u2191\u2193"),
          chalk.hex(TEXT_MUTED)("select"),
          sep,
          keyStyle("s"),
          chalk.hex(TEXT_MUTED)("stop"),
          sep,
          keyStyle("Tab"),
          chalk.hex(TEXT_MUTED)("next"),
          sep,
          keyStyle("q"),
          chalk.hex(TEXT_MUTED)("quit"),
        ].join("");
      case "sessions":
        return [
          keyStyle("\u2191\u2193"),
          chalk.hex(TEXT_MUTED)("select"),
          sep,
          keyStyle("d"),
          chalk.hex(TEXT_MUTED)("delete"),
          sep,
          keyStyle("Tab"),
          chalk.hex(TEXT_MUTED)("next"),
          sep,
          keyStyle("q"),
          chalk.hex(TEXT_MUTED)("quit"),
        ].join("");
      case "logs":
        return [
          keyStyle("\u2191\u2193"),
          chalk.hex(TEXT_MUTED)("scroll"),
          sep,
          keyStyle("Space"),
          chalk.hex(TEXT_MUTED)("follow"),
          sep,
          keyStyle("f"),
          chalk.hex(TEXT_MUTED)("filter"),
          sep,
          keyStyle("/"),
          chalk.hex(TEXT_MUTED)("search"),
          sep,
          keyStyle("Esc"),
          chalk.hex(TEXT_MUTED)("menu"),
          sep,
          keyStyle("q"),
          chalk.hex(TEXT_MUTED)("quit"),
        ].join("");
      default:
        return [
          keyStyle("1-5"),
          chalk.hex(TEXT_MUTED)("views"),
          sep,
          keyStyle("q"),
          chalk.hex(TEXT_MUTED)("quit"),
        ].join("");
    }
  }

  function renderSearchOverlay(): string[] {
    if (!searchActive) return [];
    const w = Math.min(cols - 8, 50);
    const pad = Math.max(0, Math.floor((cols - w) / 2));
    const sp = " ".repeat(pad);
    const lines: string[] = [];
    lines.push(sp + boxTop(w, "heavy"));
    lines.push(
      sp + boxLine(chalk.hex(BRAND).bold(" Search Logs"), w, "left", BRAND),
    );
    lines.push(
      sp +
        boxLine(
          `  ${chalk.hex(TEXT_PRIMARY)(searchBuffer)}${chalk.hex(BRAND)("\u2588")}`,
          w,
          "left",
          BRAND,
        ),
    );
    lines.push(
      sp +
        boxLine(
          chalk.hex(TEXT_MUTED)("  Enter to confirm \u2502 Esc to cancel"),
          w,
          "left",
          BRAND,
        ),
    );
    lines.push(sp + boxBot(w, "heavy"));
    return lines;
  }

  function render(): void {
    const w = cols;
    const lines: string[] = [];

    const header = renderHeader();
    lines.push(...header);

    if (currentView !== "menu") {
      lines.push(...renderTabs());
    }

    const headerLines =
      header.length + (currentView !== "menu" ? renderTabs().length : 0);
    const footerLines = 3;
    const contentRows = rows - headerLines - footerLines;

    switch (currentView) {
      case "menu":
        lines.push(...renderMenu(contentRows, w));
        break;
      case "overview":
        lines.push(...renderOverview(contentRows, w));
        break;
      case "accounts":
        lines.push(...renderAccounts(contentRows, w));
        break;
      case "streams":
        lines.push(...renderStreams(contentRows, w));
        break;
      case "sessions":
        lines.push(...renderSessions(contentRows, w));
        break;
      case "logs":
        lines.push(...renderLogs(contentRows, w));
        break;
    }

    while (lines.length < rows - footerLines) {
      lines.push("");
    }

    const toast = renderToast();
    lines.push(chalk.hex(SURFACE_LIGHT)("\u2501".repeat(w)));
    const footerContent = toast
      ? `${renderFooter()}  ${toast}`
      : renderFooter();
    lines.push(`  ${footerContent}`);

    if (searchActive) {
      const overlay = renderSearchOverlay();
      const insertAt = Math.floor(rows / 2) - Math.floor(overlay.length / 2);
      for (let i = 0; i < overlay.length; i++) {
        if (insertAt + i < lines.length) {
          lines[insertAt + i] = overlay[i];
        } else {
          lines.push(overlay[i]);
        }
      }
    }

    process.stdout.write("\x1b[H\x1b[J");
    process.stdout.write(lines.slice(0, rows).join("\n"));
  }

  function handleKey(_str: string | undefined, key: any) {
    if (!key) return;

    if (key.ctrl && key.name === "c") {
      cleanup();
      process.exit(0);
    }

    if (searchActive) {
      if (key.name === "escape") {
        searchActive = false;
        searchBuffer = "";
      } else if (key.name === "return") {
        searchActive = false;
        searchQuery = searchBuffer;
      } else if (key.name === "backspace") {
        searchBuffer = searchBuffer.slice(0, -1);
      } else if (_str && _str.length === 1) {
        searchBuffer += _str;
      }
      render();
      return;
    }

    switch (key.name) {
      case "q":
        cleanup();
        process.exit(0);
        break;
      case "escape":
        searchQuery = "";
        currentView = "menu";
        selectedIndex = 0;
        scrollOffset = 0;
        render();
        break;
      case "tab": {
        const idx = views.indexOf(currentView);
        const next = key.shift
          ? (idx - 1 + views.length) % views.length
          : (idx + 1) % views.length;
        currentView = views[next];
        selectedIndex = 0;
        scrollOffset = 0;
        autoFollow = currentView === "logs";
        render();
        break;
      }
      case "left": {
        const idx = views.indexOf(currentView);
        currentView = views[(idx - 1 + views.length) % views.length];
        selectedIndex = 0;
        scrollOffset = 0;
        autoFollow = currentView === "logs";
        render();
        break;
      }
      case "right": {
        const idx = views.indexOf(currentView);
        currentView = views[(idx + 1) % views.length];
        selectedIndex = 0;
        scrollOffset = 0;
        autoFollow = currentView === "logs";
        render();
        break;
      }
      case "up": {
        if (currentView === "logs") {
          autoFollow = false;
          scrollOffset = Math.max(0, scrollOffset - 1);
        } else if (currentView === "menu") {
          selectedIndex = Math.max(0, selectedIndex - 1);
        } else selectedIndex = Math.max(0, selectedIndex - 1);
        render();
        break;
      }
      case "down": {
        if (currentView === "logs") {
          autoFollow = false;
          const max = logs.length - (rows - 8);
          scrollOffset = Math.min(max, scrollOffset + 1);
        } else if (currentView === "menu") {
          selectedIndex = Math.min(4, selectedIndex + 1);
        } else {
          const max =
            currentView === "accounts"
              ? accounts.length - 1
              : currentView === "streams"
                ? streams.length - 1
                : currentView === "sessions"
                  ? sessions.length - 1
                  : 0;
          selectedIndex = Math.min(max, selectedIndex + 1);
        }
        render();
        break;
      }
      case "pageup": {
        autoFollow = false;
        scrollOffset = Math.max(0, scrollOffset - (rows - 8));
        render();
        break;
      }
      case "pagedown": {
        autoFollow = false;
        const max = logs.length - (rows - 8);
        scrollOffset = Math.min(Math.max(0, max), scrollOffset + (rows - 8));
        render();
        break;
      }
      case "space": {
        if (currentView === "logs") {
          autoFollow = !autoFollow;
          if (autoFollow) scrollOffset = 0;
        }
        render();
        break;
      }
      case "return": {
        if (currentView === "menu" && overview) {
          const items: View[] = [
            "overview",
            "accounts",
            "streams",
            "sessions",
            "logs",
          ];
          currentView = items[selectedIndex] || "overview";
          selectedIndex = 0;
          scrollOffset = 0;
          autoFollow = currentView === "logs";
          render();
        }
        break;
      }
      case "f": {
        if (currentView === "logs") {
          const levels = ["all", "error", "warn", "info", "debug"];
          const idx = levels.indexOf(levelFilter);
          levelFilter = levels[(idx + 1) % levels.length];
        }
        render();
        break;
      }
      case "slash": {
        searchActive = true;
        searchBuffer = "";
        render();
        break;
      }
      case "c": {
        if (currentView === "accounts" && accounts[selectedIndex]) {
          const acc = accounts[selectedIndex];
          showToast(`Clearing cooldown for ${acc.email}...`, "info");
          render();
          api(`/admin/api/accounts/${acc.id}/clear-cooldown`, {
            method: "POST",
          }).then(() => {
            showToast(`Cooldown cleared for ${acc.email}`, "success");
            pollAccounts().then(render);
          });
        }
        break;
      }
      case "s": {
        if (currentView === "streams" && streams[selectedIndex]) {
          const stream = streams[selectedIndex];
          showToast(`Stopping stream ${stream.key.slice(0, 12)}...`, "info");
          render();
          api(`/admin/api/streams/${encodeURIComponent(stream.key)}/stop`, {
            method: "POST",
          }).then(() => {
            showToast("Stream stopped", "success");
            pollStreams().then(render);
          });
        }
        break;
      }
      case "d": {
        if (currentView === "sessions" && sessions[selectedIndex]) {
          const sess = sessions[selectedIndex];
          showToast(
            `Deleting session ${sess.sessionKey.slice(0, 12)}...`,
            "info",
          );
          render();
          api(`/admin/api/sessions/${encodeURIComponent(sess.sessionKey)}`, {
            method: "DELETE",
          }).then(() => {
            showToast("Session deleted", "success");
            pollSessions().then(render);
          });
        }
        break;
      }
      default: {
        const num = parseInt(_str || "");
        if (num >= 1 && num <= views.length) {
          currentView = views[num - 1];
          selectedIndex = 0;
          scrollOffset = 0;
          autoFollow = currentView === "logs";
          render();
        }
        break;
      }
    }
  }

  await authenticate();

  process.stdin.on("keypress", handleKey);
  process.stdout.on("resize", () => {
    cols = process.stdout.columns || 80;
    rows = process.stdout.rows || 24;
    render();
  });

  render();

  const spinnerInterval = setInterval(() => {
    spinnerFrame++;
  }, 80);

  const interval = setInterval(async () => {
    if (!running) return;
    await poll();
    if (running) render();
  }, 2000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    clearInterval(spinnerInterval);
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(interval);
    clearInterval(spinnerInterval);
    cleanup();
    process.exit(0);
  });

  await new Promise(() => {});
}

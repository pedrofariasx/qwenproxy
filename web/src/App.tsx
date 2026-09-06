import { useEffect, useState, useCallback } from "react";
import {
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Activity,
  KeyRound,
  Layers,
  LogOut,
  Server,
  Settings,
  TerminalSquare,
  ScrollText,
  Database,
  Box,
  Terminal,
  TrendingUp,
  Waves,
  Sun,
  Moon,
  Menu,
  Search,
  RefreshCw,
  Snowflake,
  Download,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Toaster } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Login } from "@/components/login";
import { ErrorBoundary } from "@/components/error-boundary";
import { OverviewPage } from "@/pages/overview";
import { AccountsPage } from "@/pages/accounts";
import { UsersPage } from "@/pages/users";
import { SettingsPage } from "@/pages/settings";
import { MetricsPage } from "@/pages/metrics";
import { LogsPage } from "@/pages/logs";
import { SessionsPage } from "@/pages/sessions";
import { ModelsPage } from "@/pages/models";
import { PlaygroundPage } from "@/pages/playground";
import { UsagePage } from "@/pages/usage";
import { StreamsPage } from "@/pages/streams";
import { PersonalizationPage } from "@/pages/personalization";

const NAV = [
  { path: "/overview", key: "nav.overview", icon: Activity },
  { path: "/accounts", key: "nav.accounts", icon: Server },
  { path: "/users", key: "nav.apiKeys", icon: KeyRound },
  { path: "/streams", key: "nav.streams", icon: Waves },
  { path: "/models", key: "nav.models", icon: Box },
  { path: "/sessions", key: "nav.sessions", icon: Database },
  { path: "/playground", key: "nav.playground", icon: Terminal },
  { path: "/usage", key: "nav.usage", icon: TrendingUp },
  { path: "/metrics", key: "nav.metrics", icon: TerminalSquare },
  { path: "/logs", key: "nav.logs", icon: ScrollText },
  { path: "/personalization", key: "nav.personalization", icon: Sparkles },
  { path: "/settings", key: "nav.settings", icon: Settings },
];

function Clock() {
  const { i18n } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Badge variant="outline" className="font-mono text-xs">
      {now.toLocaleTimeString(i18n.language)}
    </Badge>
  );
}

function getActiveKey(pathname: string) {
  if (pathname === "/" || pathname === "/overview") return "nav.overview";
  return NAV.find((n) => n.path === pathname)?.key ?? "";
}

export function App() {
  const { t, i18n } = useTranslation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [uptime, setUptime] = useState<string>("—");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useState(true);
  const [cmdOpen, setCmdOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const ACTIONS = [
    {
      key: "common.restartServer",
      icon: RefreshCw,
      run: () => {
        fetch("/admin/api/restart", { method: "POST" });
        toast.success(t("common.restarting"));
      },
    },
    {
      key: "common.clearCooldowns",
      icon: Snowflake,
      run: () =>
        api
          .clearCooldowns()
          .then((r) =>
            toast.success(t("common.cooldownsCleared", { count: r.cleared })),
          )
          .catch((e) => toast.error(e?.message || t("common.failed"))),
    },
    {
      key: "common.downloadMetrics",
      icon: Download,
      run: async () => {
        try {
          const text = await api.exportMetrics();
          const a = document.createElement("a");
          a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
          a.download = "qwenproxy-metrics.txt";
          a.click();
        } catch (e: any) {
          toast.error(e?.message || t("common.downloadFailed"));
        }
      },
    },
  ];

  useEffect(() => {
    const stored = localStorage.getItem("qwenproxy-theme");
    const isDark =
      stored !== null
        ? stored === "dark"
        : !window.matchMedia("(prefers-color-scheme: light)").matches;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
    window.dispatchEvent(new Event("qwenproxy:themechange"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  const handleToggleTheme = () => {
    setDark((v) => {
      const next = !v;
      document.documentElement.classList.toggle("dark", next);
      localStorage.setItem("qwenproxy-theme", next ? "dark" : "light");
      window.dispatchEvent(new Event("qwenproxy:themechange"));
      return next;
    });
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    fetch("/admin/api/session")
      .then((r) => r.json())
      .then((j) => {
        setAuthed(!!j.authenticated);
        if (j.uptime != null) {
          const s = j.uptime;
          setUptime(
            s >= 86400
              ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
              : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`,
          );
        }
      })
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const handleCmdSelect = useCallback((cb: () => void) => {
    setCmdOpen(false);
    cb();
  }, []);

  if (authed === null) return null;
  if (!authed) return <Login />;

  return (
    <div className="flex min-h-svh">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all duration-200",
          !sidebarOpen && "-translate-x-full lg:translate-x-0",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div className="flex items-center justify-center px-5 py-7">
          <img
            src={`${import.meta.env.BASE_URL}${dark ? "qwenproxy.png" : "qwenproxy-dark.png"}`}
            alt="QwenProxy"
            className={cn(
              "h-auto shrink-0 object-contain",
              collapsed ? "w-24" : "w-48",
            )}
          />
        </div>
        <Separator />
        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV.slice(0, -2).map((item) => {
            const Icon = item.icon;
            const active =
              location.pathname === item.path ||
              (item.path === "/overview" && location.pathname === "/");
            return (
              <button
                key={item.path}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground text-muted-foreground",
                  active && "bg-accent text-accent-foreground",
                  collapsed && "justify-center px-2",
                )}
                onClick={() => navigate(item.path)}
                title={collapsed ? t(item.key) : undefined}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && t(item.key)}
              </button>
            );
          })}
          <Separator className="my-1" />
          {NAV.slice(-2).map((item) => {
            const Icon = item.icon;
            const active = location.pathname === item.path;
            return (
              <button
                key={item.path}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground text-muted-foreground",
                  active && "bg-accent text-accent-foreground",
                  collapsed && "justify-center px-2",
                )}
                onClick={() => navigate(item.path)}
                title={collapsed ? t(item.key) : undefined}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && t(item.key)}
              </button>
            );
          })}
        </nav>
        <div
          className={cn(
            "space-y-3 border-t p-4 text-xs text-muted-foreground",
            collapsed && "space-y-2 p-2",
          )}
        >
          <div
            className={cn(
              "flex items-center gap-2",
              collapsed && "justify-center",
            )}
          >
            <Layers className="size-3" />
            {!collapsed && (
              <>
                {t("common.uptime")} {uptime}
              </>
            )}
          </div>
          <div
            className={cn(
              "flex items-center gap-2",
              collapsed && "justify-center",
            )}
          >
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
            </span>
            {!collapsed && t("common.online")}
          </div>
          {!collapsed && (
            <a
              href="https://www.buymeacoffee.com/pedrofariasx"
              target="_blank"
              rel="noopener noreferrer"
              className="flex justify-center pt-2"
            >
              <img
                src="https://img.buymeacoffee.com/button-api/?text=Support Qwenproxy&emoji=🚀&slug=pedrofariasx&button_colour=6c3fe1&font_colour=ffffff&font_family=Lato&outline_colour=ffffff&coffee_colour=FFDD00"
                alt="Support Qwenproxy"
              />
            </a>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              fetch("/admin/api/logout", { method: "POST" }).finally(() =>
                window.location.replace("/admin"),
              );
            }}
          >
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className={cn("w-full", collapsed && "px-0")}
            >
              {collapsed ? <LogOut className="size-4" /> : t("common.logout")}
            </Button>
          </form>
        </div>
      </aside>

      <main
        className={cn("min-w-0 flex-1", collapsed ? "lg:pl-16" : "lg:pl-60")}
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/90 px-6 py-3 backdrop-blur lg:px-8">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="hidden lg:inline-flex"
              onClick={() => setCollapsed((v) => !v)}
            >
              <Menu className="size-5" />
            </Button>
            <h1 className="text-sm font-semibold uppercase tracking-widest text-foreground">
              {t(getActiveKey(location.pathname))}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setCmdOpen(true)}
            >
              <Search className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleToggleTheme}>
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Select
              value={i18n.language}
              onValueChange={(v) => i18n.changeLanguage(v)}
            >
              <SelectTrigger
                className="h-9 w-auto gap-1 px-2 text-xs font-medium ghost"
                aria-label={t("common.switchLanguage")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {(i18n.options.supportedLngs || []).map((lng: string) => (
                  <SelectItem key={lng} value={lng}>
                    {lng.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Clock />
          </div>
        </header>
        <div className="p-6 lg:p-8">
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route
              path="/overview"
              element={
                <ErrorBoundary>
                  <OverviewPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/accounts"
              element={
                <ErrorBoundary>
                  <AccountsPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/users"
              element={
                <ErrorBoundary>
                  <UsersPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/streams"
              element={
                <ErrorBoundary>
                  <StreamsPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/settings"
              element={
                <ErrorBoundary>
                  <SettingsPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/metrics"
              element={
                <ErrorBoundary>
                  <MetricsPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/logs"
              element={
                <ErrorBoundary>
                  <LogsPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/sessions"
              element={
                <ErrorBoundary>
                  <SessionsPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/models"
              element={
                <ErrorBoundary>
                  <ModelsPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/playground"
              element={
                <ErrorBoundary>
                  <PlaygroundPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/usage"
              element={
                <ErrorBoundary>
                  <UsagePage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/personalization"
              element={
                <ErrorBoundary>
                  <PersonalizationPage />
                </ErrorBoundary>
              }
            />
          </Routes>
        </div>
      </main>

      <Toaster position="top-center" theme={dark ? "dark" : "light"} />

      <CommandDialog
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        title="Command Palette"
        description={t("common.searchCommandOrPage")}
      >
        <CommandInput placeholder={t("common.search")} />
        <CommandList>
          <CommandEmpty>{t("common.noResults")}</CommandEmpty>
          <CommandGroup heading={t("common.pages")}>
            {NAV.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.path}
                  value={t(item.key)}
                  onSelect={() => handleCmdSelect(() => navigate(item.path))}
                >
                  <Icon className="size-4" />
                  {t(item.key)}
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandGroup heading={t("common.actions")}>
            {ACTIONS.map((a) => {
              const Icon = a.icon;
              return (
                <CommandItem
                  key={a.key}
                  value={t(a.key)}
                  onSelect={() => handleCmdSelect(a.run)}
                >
                  <Icon className="size-4" />
                  {t(a.key)}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </div>
  );
}

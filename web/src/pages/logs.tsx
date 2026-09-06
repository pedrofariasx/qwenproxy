import { useState, useEffect, useRef, useCallback } from 'react'
import { Play, Pause, Trash2, Search, Filter } from 'lucide-react'
import { toast } from 'sonner'
import { api, type LogEntry } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTranslation } from 'react-i18next'

const LEVEL_STYLES: Record<LogEntry['level'], string> = {
  error: 'bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400',
  warn: 'bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400',
  info: 'bg-cyan-500/15 text-cyan-700 border-cyan-500/30 dark:text-cyan-400',
  debug: 'bg-zinc-500/15 text-zinc-600 border-zinc-500/30 dark:text-zinc-400',
}

type LevelFilter = 'all' | LogEntry['level']

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toTimeString().slice(0, 8)
}

export function LogsPage() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [buffer, setBuffer] = useState<LogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [search, setSearch] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    api.logs()
      .then(setLogs)
      .catch(() => toast.error(t('logs.loadFailed')))
  }, [])

  useEffect(() => {
    const es = new EventSource('/admin/api/logs/live')
    es.addEventListener('log', (e) => {
      try {
        const entry: LogEntry = JSON.parse(e.data)
        setPaused((p) => {
          if (p) {
            setBuffer((b) => [...b, entry])
          } else {
            setLogs((l) => [...l, entry])
          }
          return p
        })
      } catch { /* ignore parse errors */ }
    })
    return () => es.close()
  }, [])

  useEffect(() => {
    if (!scrollRef.current) return
    if (!viewportRef.current) {
      viewportRef.current = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
    }
    const vp = viewportRef.current
    if (!vp || !autoScroll || paused) return
    vp.scrollTop = vp.scrollHeight
  })

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (p) {
        setBuffer((b) => {
          if (b.length > 0) {
            setLogs((l) => [...l, ...b])
          }
          return []
        })
      }
      return !p
    })
  }, [])

  const clearLogs = useCallback(async () => {
    try {
      await api.clearLogs()
      setLogs([])
      setBuffer([])
    } catch {
      toast.error(t('logs.clearFailed'))
    }
  }, [])

  const filteredLogs = logs.filter((log) => {
    if (levelFilter !== 'all' && log.level !== levelFilter) return false
    if (search && !log.message.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const levels: { key: LevelFilter; label: string }[] = [
    { key: 'all', label: t('logs.all') },
    { key: 'debug', label: t('logs.debug') },
    { key: 'info', label: t('logs.info') },
    { key: 'warn', label: t('logs.warn') },
    { key: 'error', label: t('logs.error') },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={paused ? 'default' : 'outline'}
          size="sm"
          onClick={togglePause}
        >
          {paused ? <Play className="size-4 mr-1" /> : <Pause className="size-4 mr-1" />}
          {paused ? t('logs.resume') : t('logs.pause')}
          {buffer.length > 0 && paused && (
            <Badge variant="secondary" className="ml-2">{buffer.length}</Badge>
          )}
        </Button>

        <Button
          variant={autoScroll ? 'default' : 'outline'}
          size="sm"
          onClick={() => setAutoScroll((v) => !v)}
        >
          {autoScroll ? t('logs.autoScrollOn') : t('logs.autoScrollOff')}
        </Button>

        <Button variant="outline" size="sm" onClick={clearLogs}>
          <Trash2 className="size-4 mr-1" />{t('logs.clear')}</Button>

        <div className="flex items-center gap-1 ml-auto">
          <Filter className="size-4 text-muted-foreground" />
          {levels.map((l) => (
            <Button
              key={l.key}
              variant={levelFilter === l.key ? 'default' : 'outline'}
              size="sm"
              onClick={() => setLevelFilter(l.key)}
            >
              {l.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t('logs.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <Card>
        <ScrollArea ref={scrollRef} className="h-[calc(100vh-12rem)]">
          <div className="p-3 space-y-0.5 font-mono text-sm">
            {filteredLogs.length === 0 && (
              <p className="text-muted-foreground text-center py-8">{t("logs.noLogs")}</p>
            )}
            {filteredLogs.map((log) => (
              <div key={log.id} className="flex items-start gap-2 py-1 px-2 rounded hover:bg-muted/50">
                <span className="text-muted-foreground shrink-0">{formatTime(log.timestamp)}</span>
                <Badge variant="outline" className={`shrink-0 text-xs ${LEVEL_STYLES[log.level]}`}>
                  {log.level}
                </Badge>
                {log.context && (
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {log.context}
                  </Badge>
                )}
                <span className="break-all">{log.message}</span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </Card>
    </div>
  )
}

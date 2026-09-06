import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslation } from 'react-i18next'

export function MetricsPage() {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setText(await api.metrics())
    } catch (err: any) {
      setText(`${t('metrics.errorPrefix')} ${t('metrics.fetchFailed')}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])

  const lines = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = text.split('\n').filter((l) => !q || l.toLowerCase().includes(q))
    const groups: { name: string; lines: string[] }[] = []
    let current: { name: string; lines: string[] } | null = null
    const seen = new Set<string>()
    for (const line of filtered) {
      const m = line.match(/^(# (?:HELP|TYPE) (\S+)|(\S+)\{?)/)
      const name = m?.[2] || m?.[3] || null
      if (name && !line.startsWith('# TYPE')) {
        if (name && !seen.has(name)) {
          seen.add(name)
          groups.push({ name, lines: [line] })
          current = groups[groups.length - 1]
        } else if (current && !line.startsWith('#')) {
          current.lines.push(line)
        }
      } else if (!line.startsWith('#')) {
        current?.lines.push(line)
      }
    }
    return groups
  }, [text, query])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('metrics.copied'))
    } catch {
      toast.error(t('metrics.copyFailed'))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('metrics.filterPlaceholder')} className="pl-8 font-mono text-xs" />
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={copy}>
            <Copy />{t('metrics.copy')}</Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : ''} />{t('metrics.refresh')}</Button>
        </div>
      </div>

      {loading && !text ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {lines.map((g) => (
            <Card key={g.name}>
              <CardHeader className="py-3">
                <CardTitle className="font-mono text-xs">{g.name}</CardTitle>
              </CardHeader>
              <CardContent className="py-2">
                <pre className="max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
                  {g.lines.join('\n')}
                </pre>
              </CardContent>
            </Card>
          ))}
          {lines.length === 0 ? (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">{t('metrics.noMetricsFound', { query: query })}</CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  )
}
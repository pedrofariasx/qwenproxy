import { useCallback, useEffect, useMemo, useState } from 'react'
import i18next from 'i18next'
import { toast } from 'sonner'
import { Box, Cpu, Crown, Search } from 'lucide-react'
import { api, type CatalogModel } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

type VariantFilter = 'all' | 'base' | 'thinking' | 'no-thinking'

function formatContextWindow(n?: number): string {
  if (n == null) return '—'
  if (n >= 1000000) return `${n / 1000000}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

function variantOf(id: string): 'base' | 'thinking' | 'no-thinking' {
  if (id.endsWith('-thinking')) return 'thinking'
  if (id.endsWith('-no-thinking')) return 'no-thinking'
  return 'base'
}

const VARIANT_LABEL: Record<Exclude<VariantFilter, 'all'>, string> = {
  base: 'Base',
  thinking: 'Thinking',
  'no-thinking': 'No thinking',
}

const ABILITY_LABEL: Record<string, string> = {
  text: i18next.t('models.abilityText'),
  multimodal: i18next.t('models.abilityMultimodal'),
  qwen_code: i18next.t('models.abilityCode'),
  qwen_search: i18next.t('models.abilitySearch'),
  qwen_artifact: i18next.t('models.abilityArtifact'),
  image_gen: i18next.t('models.abilityImage'),
  video_gen: i18next.t('models.abilityVideo'),
  audio_gen: i18next.t('models.abilityAudio'),
}

export function ModelsPage() {
  const { t, i18n } = useTranslation()
  const [data, setData] = useState<{ catalog: CatalogModel[]; used: CatalogModel[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [variant, setVariant] = useState<VariantFilter>('all')

  const load = useCallback(async () => {
    try {
      const res = await api.models()
      setData({
        catalog: res.catalog || [],
        used: res.models.map((m) => ({ ...m, requestCount: m.requestCount })),
      })
      setLoading(false)
    } catch (err: any) {
      toast.error(err?.message || t('models.loadFailed'))
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 60000)
    return () => clearInterval(interval)
  }, [load])

  const mostUsed = useMemo(() => {
    if (!data) return []
    const usageById = new Map(data.used.map((m) => [m.id, m.requestCount]))
    const byId = new Map(data.catalog.map((m) => [m.id, m]))
    const ids = new Set<string>([...usageById.keys(), ...byId.keys()])
    const rows: CatalogModel[] = []
    for (const id of ids) {
      const catalogModel = byId.get(id)
      const requestCount = catalogModel?.requestCount ?? usageById.get(id) ?? 0
      if (requestCount > 0) {
        rows.push({ ...(catalogModel ?? { id, requestCount: 0 }), id, requestCount })
      }
    }
    return rows.sort((a, b) => b.requestCount - a.requestCount)
  }, [data])

  const totalRequests = useMemo(
    () => data?.used.reduce((sum, m) => sum + m.requestCount, 0) ?? 0,
    [data]
  )
  const topModel = mostUsed[0] ?? null
  const maxCount = mostUsed.length > 0 ? mostUsed[0].requestCount : 0

  const filtered = useMemo(() => {
    if (!data) return []
    const term = search.toLowerCase()
    return data.catalog
      .filter((m) => m.id.toLowerCase().includes(term) || (m.name ?? '').toLowerCase().includes(term))
      .filter((m) => variant === 'all' || variantOf(m.id) === variant)
      .sort((a, b) => {
        if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount
        return a.id.localeCompare(b.id)
      })
  }, [data, search, variant])

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">…</CardTitle>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('models.availableModels')}</CardTitle>
            <Box className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.catalog.length ?? 0}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {data?.catalog.length ? t('models.baseModelsWithVariants', { count: Math.round(data.catalog.length / 3) }) : t('models.catalogUnavailable')}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('models.totalRequests')}</CardTitle>
            <Cpu className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalRequests.toLocaleString(i18n.language)}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {data?.used.length ?? 0} {t('models.modelsWithUsage')}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t("models.mostUsedModel")}</CardTitle>
            <Crown className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="truncate text-lg font-semibold">{topModel?.id || '—'}</div>
            {topModel ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {topModel.requestCount.toLocaleString(i18n.language)} {t('models.reqSuffix')}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("models.topModels")}</CardTitle>
          <CardDescription>
            {t('models.rankingByRequests')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mostUsed.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Crown className="size-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t('models.noUsageYet')}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {mostUsed.slice(0, 10).map((m, i) => (
                <div key={m.id} className="flex items-center gap-3">
                  <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">{i + 1}</span>
                  <Badge variant="outline" className="w-16 shrink-0 justify-center text-[10px]">
                    {VARIANT_LABEL[variantOf(m.id)]}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                  <div className="h-2 w-32 shrink-0 overflow-hidden rounded-full bg-muted sm:w-48">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all',
                        i === 0 ? 'bg-amber-400' : i < 3 ? 'bg-emerald-400' : 'bg-violet-400'
                      )}
                      style={{ width: `${maxCount > 0 ? (m.requestCount / maxCount) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right font-mono text-xs">
                    {m.requestCount.toLocaleString(i18n.language)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('models.modelCatalog')}</CardTitle>
          <CardDescription>
            {t('models.modelsAvailable', { count: data?.catalog.length ?? 0 })}
          </CardDescription>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t('models.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={variant} onValueChange={(v) => setVariant(v as VariantFilter)}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder={t('models.variantPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("models.filterAll")}</SelectItem>
                <SelectItem value="base">{t("models.filterBase")}</SelectItem>
                <SelectItem value="thinking">{t("models.filterThinking")}</SelectItem>
                <SelectItem value="no-thinking">{t("models.filterNoThinking")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Box className="mb-4 size-12 text-muted-foreground" />
              <p className="text-lg font-medium text-muted-foreground">
                {data?.catalog.length === 0
                  ? t('models.catalogUnavailableNow')
                  : t('models.tryDifferentSearch')}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('models.model')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("models.tableCapabilities")}</TableHead>
                  <TableHead className="text-right">{t("models.tableContext")}</TableHead>
                  <TableHead className="text-right">{t('models.requests')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((m) => (
                  <TableRow key={m.id} className={m.requestCount > 0 ? 'bg-amber-500/[0.04]' : ''}>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">{m.id}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {VARIANT_LABEL[variantOf(m.id)]}
                          </Badge>
                          {m.requestCount > 0 && (
                            <Badge variant="secondary" className="text-[10px]">{t("models.inUseBadge")}</Badge>
                          )}
                        </div>
                        {m.name ? <span className="text-xs text-muted-foreground">{m.name}</span> : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {Array.isArray(m.capabilities) && m.capabilities.length > 0 ? (
                          m.capabilities.map((cap) => (
                            <Badge key={cap} variant="outline" className="font-normal text-muted-foreground">
                              {ABILITY_LABEL[cap] ?? cap}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatContextWindow(m.contextWindow)}
                    </TableCell>
                    <TableCell className="text-right">
                      {m.requestCount > 0 ? (
                        <Badge variant="secondary" className="font-mono">
                          {m.requestCount.toLocaleString(i18n.language)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
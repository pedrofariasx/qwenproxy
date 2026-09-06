import { useCallback, useEffect, useState } from 'react'
import { Users, BarChart3, Clock, AlertTriangle, TrendingUp } from 'lucide-react'
import { api, type UsageData } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartCard, BarTrend } from '@/components/charts'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return i18next.t('usage.secondsAgo', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return i18next.t('usage.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return i18next.t('usage.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return i18next.t('usage.daysAgo', { count: days })
}

function Kpi({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  )
}

export function UsagePage() {
  const { t, i18n } = useTranslation()
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setData(await api.usage())
    } catch {
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 15000)
    return () => clearInterval(interval)
  }, [load])

  const sortedUsers = data ? [...data.users].sort((a, b) => b.requestCount - a.requestCount) : []
  const totalRequests = sortedUsers.reduce((sum, u) => sum + u.requestCount, 0)
  const totalInputTokens = sortedUsers.reduce((sum, u) => sum + (u.inputTokens ?? 0), 0)
  const totalOutputTokens = sortedUsers.reduce((sum, u) => sum + (u.outputTokens ?? 0), 0)
  const totalTokens = sortedUsers.reduce((sum, u) => sum + u.totalTokens, 0)

  const modelEntries = data ? Object.entries(data.models).sort((a, b) => b[1] - a[1]) : []
  const maxModelCount = modelEntries.length > 0 ? modelEntries[0][1] : 0

  const modelChartData = modelEntries.map(([, count], i) => ({
    t: Date.now() - (modelEntries.length - i) * 60000,
    v: count,
  }))

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-96" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (!data || (data.users.length === 0 && Object.keys(data.models).length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <BarChart3 className="size-12 text-muted-foreground" />
        <p className="text-lg text-muted-foreground">{t('usage.noData')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-5">
        <Kpi icon={Users} label={t('usage.totalUsers')} value={sortedUsers.length.toLocaleString(i18n.language)} />
        <Kpi icon={TrendingUp} label={t('usage.totalRequests')} value={totalRequests.toLocaleString(i18n.language)} />
        <Kpi icon={Clock} label={t('usage.inputTokens')} value={totalInputTokens.toLocaleString(i18n.language)} />
        <Kpi icon={Clock} label={t('usage.outputTokens')} value={totalOutputTokens.toLocaleString(i18n.language)} />
        <Kpi icon={Clock} label={t('usage.totalTokens')} value={totalTokens.toLocaleString(i18n.language)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('usage.topUsers')}</CardTitle>
          <CardDescription>{t('usage.sortedByRequests')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('usage.user')}</TableHead>
                <TableHead className="text-right">{t('usage.requests')}</TableHead>
                <TableHead className="text-right">{t('usage.errors')}</TableHead>
                  <TableHead className="text-right">{t('usage.tokensIn')}</TableHead>
                  <TableHead className="text-right">{t('usage.tokensOut')}</TableHead>
                  <TableHead className="text-right">{t('usage.tokensTotal')}</TableHead>
                  <TableHead className="text-right">{t('usage.lastAccess')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedUsers.length === 0 ? (
                <TableRow>
                    <TableCell colSpan={7} className="text-muted-foreground">{t('usage.noUsersFound')}</TableCell>
                </TableRow>
              ) : (
                sortedUsers.map((u) => {
                  const errorRate = u.requestCount > 0 ? u.errorCount / u.requestCount : 0
                  return (
                    <TableRow key={u.userId}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {u.email || u.userId}
                          {errorRate > 0.1 ? (
                            <Badge variant="outline" className="gap-1 text-amber-400">
                              <AlertTriangle className="size-3" />
                              {(errorRate * 100).toFixed(1)}%
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">{u.requestCount.toLocaleString(i18n.language)}</TableCell>
                      <TableCell className="text-right">
                        {u.errorCount > 0 ? (
                          <Badge variant="destructive">{u.errorCount.toLocaleString(i18n.language)}</Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                    <TableCell className="text-right font-mono">{(u.inputTokens ?? 0).toLocaleString(i18n.language)}</TableCell>
                    <TableCell className="text-right font-mono">{(u.outputTokens ?? 0).toLocaleString(i18n.language)}</TableCell>
                    <TableCell className="text-right font-mono">{u.totalTokens.toLocaleString(i18n.language)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{timeAgo(u.lastRequestAt)}</TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {modelEntries.length > 0 ? (
        <ChartCard title={t('usage.usageByModel')} icon={BarChart3} badge={<Badge variant="secondary" className="font-mono">{t('usage.modelCount_other', { count: modelEntries.length })}</Badge>}>
          <BarTrend data={modelChartData} color="#a78bfa" unit="req" height={160} />
          <div className="mt-4 flex flex-col gap-2">
            {modelEntries.map(([model, count]) => (
              <div key={model} className="flex items-center gap-3">
                <span className="w-48 truncate font-mono text-xs text-muted-foreground">{model}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-violet-400 transition-all"
                    style={{ width: `${maxModelCount > 0 ? (count / maxModelCount) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-16 text-right font-mono text-xs">{count.toLocaleString(i18n.language)}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      ) : null}
    </div>
  )
}

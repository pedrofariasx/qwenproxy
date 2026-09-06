import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Square, Waves } from 'lucide-react'
import { api, fmtSec, type ActiveStream } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useTranslation } from 'react-i18next'

export function StreamsPage() {
  const { t } = useTranslation()
  const [streams, setStreams] = useState<ActiveStream[]>([])
  const [stopping, setStopping] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.streams()
      setStreams(d.streams || [])
    } catch (err: any) {
      // keep last known state on transient failures
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [load])

  async function stop(key: string) {
    if (!confirm(t('streams.confirmTerminate'))) return
    setStopping(key)
    try {
      const res = await api.stopStream(key)
      toast.success(res.ok ? t('streams.streamTerminated') : t('streams.streamNotFound'))
      load()
    } catch (err: any) {
      toast.error(err?.message || t('streams.terminateFailed'))
    } finally {
      setStopping(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Waves className="size-4" />{t('streams.title')}</CardTitle>
          <CardDescription>{t('streams.activeGenerations', { count: streams.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('sessions.account')}</TableHead>
                <TableHead>{t('streams.session')}</TableHead>
                <TableHead>{t('streams.age')}</TableHead>
                <TableHead className="text-right">{t('streams.action')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {streams.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    {t('streams.noStreams')}
                  </TableCell>
                </TableRow>
              ) : (
                streams.map((s) => (
                  <TableRow key={s.key}>
                    <TableCell className="font-mono text-xs">{s.accountId.slice(0, 12)}…</TableCell>
                    <TableCell className="font-mono text-xs">{s.uiSessionId.slice(0, 16)}…</TableCell>
                    <TableCell>
                      <Badge variant={s.ageMs > 120000 ? 'outline' : 'secondary'} className={s.ageMs > 120000 ? 'text-amber-400' : ''}>
                        {fmtSec(Math.floor(s.ageMs / 1000))}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="destructive" disabled={stopping === s.key} onClick={() => stop(s.key)}>
                        <Square className="size-3.5" />{t('playground.stop')}</Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

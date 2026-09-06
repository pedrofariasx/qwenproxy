import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw, Search, Trash2 } from 'lucide-react'
import { api, fmtSec, type SessionInfo } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useTranslation } from 'react-i18next'

function timeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function SessionsPage() {
  const { t } = useTranslation()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await api.sessions()
      setSessions(data)
    } catch (err: any) {
      toast.error(err?.message || t('sessions.loadFailed'))
    }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, 10_000)
    return () => clearInterval(interval)
  }, [load])

  async function deleteSession(key: string) {
    try {
      await api.deleteSession(key)
      toast.success(t('sessions.sessionRemoved'))
      load()
    } catch (err: any) {
      toast.error(err?.message || t('sessions.removeFailed'))
    }
  }

  async function clearAll() {
    if (!confirm(t('sessions.confirmRemoveAll'))) return
    try {
      await api.clearSessions()
      toast.success(t('sessions.allRemoved'))
      load()
    } catch (err: any) {
      toast.error(err?.message || t('sessions.clearFailed'))
    }
  }

  const filtered = sessions.filter(
    (s) =>
      s.sessionKey.toLowerCase().includes(search.toLowerCase()) ||
      s.chatId.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">{t('sessions.title')}</CardTitle>
              <CardDescription>{t('sessions.activeSessions', { count: sessions.length })}</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={load}>
                <RefreshCw />{t('metrics.refresh')}</Button>
              <Button size="sm" variant="destructive" onClick={clearAll}>
                <Trash2 /> {t("sessions.clearAll")}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('sessions.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("sessions.tableSessionKey")}</TableHead>
                <TableHead>{t("sessions.tableChatId")}</TableHead>
                <TableHead>{t("sessions.account")}</TableHead>
                <TableHead>{t("sessions.history")}</TableHead>
                <TableHead>TTL</TableHead>
                <TableHead>{t("sessions.updated")}</TableHead>
                <TableHead className="text-right">{t('sessions.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    {sessions.length === 0 ? t('sessions.noSessions') : t('common.noResults')}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((s) => (
                  <TableRow key={s.sessionKey}>
                    <TableCell className="font-mono text-xs">
                      {s.sessionKey.slice(0, 16)}…
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {s.chatId.slice(0, 12)}…
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {s.accountId.slice(0, 12)}…
                    </TableCell>
                    <TableCell>
                      {s.historyComplete ? (
                        <Badge variant="outline" className="text-emerald-400">complete</Badge>
                      ) : (
                        <Badge variant="outline" className="text-amber-400">bootstrap</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          s.ttlRemaining > 3600
                            ? 'text-emerald-400'
                            : s.ttlRemaining > 600
                              ? 'text-amber-400'
                              : 'text-red-400'
                        }
                      >
                        {fmtSec(s.ttlRemaining)}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {timeAgo(s.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="destructive" onClick={() => deleteSession(s.sessionKey)}>
                        <Trash2 />
                      </Button>
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

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Download, RotateCcw, Save } from 'lucide-react'
import { api, type SettingsData } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from 'react-i18next'

export function SettingsPage() {
  const { t } = useTranslation()
  const [data, setData] = useState<SettingsData | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api.settings()
      setData(d)
      setValues({ ...d.settings })
    } catch (err: any) {
      toast.error(err?.message || t('settings.loadFailed'))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function setValue(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }))
  }

  if (!data) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.essentialConfig')}</CardTitle>
          <CardDescription>{t('settings.configDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {data.allowlist.map((key) => {
              const type = data.types?.[key] || 'string'
              const value = values[key] ?? ''
              return (
                <div key={key} className="grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={`cfg-${key}`} className="font-mono text-xs">
                      {key}
                    </Label>
                    {(data.liveKeys || []).includes(key) ? (
                      <span className="rounded border border-emerald-400/40 px-1.5 py-0.5 text-[10px] text-emerald-400">{t('settings.instant')}</span>
                    ) : (
                      <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{t('settings.restart')}</span>
                    )}
                  </div>
                  {type === 'bool' ? (
                    <div className="flex h-9 items-center gap-3 rounded-md border px-3">
                      <Switch id={`cfg-${key}`} checked={value === 'true'} onCheckedChange={(c) => setValue(key, c ? 'true' : 'false')} />
                      <span className="text-sm text-muted-foreground">{value === 'true' ? 'true' : 'false'}</span>
                    </div>
                  ) : (
                    <Input id={`cfg-${key}`} type={type === 'int' ? 'number' : 'text'} value={value} onChange={(e) => setValue(key, e.target.value)} />
                  )}
                </div>
              )
            })}
          </div>
          <Separator className="my-6" />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={saving}
              onClick={async () => {
                setSaving(true)
                try {
                  const patch: Record<string, string> = {}
                  for (const key of data.allowlist) {
                    const v = values[key] ?? ''
                    if (v !== '') patch[key] = v
                  }
                  const res = await api.saveSettings(patch)
                  if (res.live?.length && !res.restartRequired) {
                    toast.success(t('settings.appliedInstant'))
                  } else if (res.live?.length && res.restartRequired) {
                    toast.success(t('settings.appliedPartialRestart'))
                  } else {
                    toast.success(t('settings.savedRestartRequired'))
                  }
                  load()
                } catch (err: any) {
                  toast.error(err?.message || t('settings.saveFailed'))
                } finally {
                  setSaving(false)
                }
              }}
            >
              <Save />{t('settings.save')}</Button>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setValues({ ...data.settings })}
            >
              <RotateCcw />{t('settings.discard')}</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.actionsTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="destructive"
              onClick={() => {
                if (!confirm(t('settings.confirmRestart'))) return
                fetch('/admin/api/restart', { method: 'POST' })
                  .then(() => toast.success(t('common.restarting')))
                  .catch((e) => toast.error(e.message))
                setTimeout(() => window.location.reload(), 1500)
              }}
            >{t('settings.restartServer')}</Button>
            <Button
              variant="outline"
              onClick={async () => {
                const text = await api.metrics()
                const a = document.createElement('a')
                a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`
                a.download = 'metrics.txt'
                a.click()
              }}
            >
              <Download />{t('settings.downloadMetrics')}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Fingerprint, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { api, fmtSec, type Account, type AccountFingerprint, type FingerprintProfile } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from 'react-i18next'

export function AccountsPage() {
  const { t } = useTranslation()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [inUse, setInUse] = useState<string[]>([])
  const [maxLoad, setMaxLoad] = useState(2)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [fp, setFp] = useState<AccountFingerprint | null>(null)
  const [fpLoading, setFpLoading] = useState(false)

  function LoadBar({ value }: { value: number }) {
    const pct = Math.min(100, (value / Math.max(1, maxLoad)) * 100)
    const tone = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-400' : 'bg-emerald-400'
    return (
      <div className="ml-auto flex w-28 items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
        </div>
        <span className="font-mono text-xs text-muted-foreground">{value}</span>
      </div>
    )
  }

  const load = useCallback(async () => {
    try {
      const d = await api.accounts()
      setAccounts(d.accounts)
      setInUse(d.inUse)
      if (d.maxStreamsPerAccount) setMaxLoad(d.maxStreamsPerAccount)
    } catch (err: any) {
      toast.error(err?.message || t('accounts.loadFailed'))
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  async function add() {
    if (!email.trim() || !password) return
    setBusy(true)
    try {
      await api.addAccount(email.trim(), password)
      setEmail('')
      setPassword('')
      toast.success(t('accounts.accountAdded'))
      load()
    } catch (err: any) {
      toast.error(err?.message || t('accounts.addFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!confirm(t('accounts.confirmRemove'))) return
    await api.removeAccount(id)
    toast.success(t('accounts.accountRemoved'))
    load()
  }

  async function showFp(id: string) {
    setFpLoading(true)
    try {
      setFp(await api.accountFingerprint(id))
    } catch (err: any) {
      toast.error(err?.message || t('accounts.fingerprintLoadFailed'))
    } finally {
      setFpLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("accounts.qwenAccounts")}</CardTitle>
          <CardDescription>{accounts.length} {t('accounts.accountsConfigured')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('accounts.email')}</TableHead>
                <TableHead>{t("accounts.tableId")}</TableHead>
                <TableHead className="text-right">{t("accounts.tableLoad")}</TableHead>
                <TableHead className="w-20">Streams</TableHead>
                <TableHead>{t("overview.cooldown")}</TableHead>
                <TableHead>{t("accounts.tableInUse")}</TableHead>
                <TableHead className="w-28">{t('accounts.fingerprint')}</TableHead>
                <TableHead className="text-right">{t('accounts.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground">
                    {t('accounts.noAccountAddBelow')}
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.email}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{a.id.slice(0, 8)}…</TableCell>
                    <TableCell className="text-right">
                      <LoadBar value={a.activeLoad} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{a.streams ?? 0}</TableCell>
                    <TableCell>
                      {a.cooldown > 0 ? (
                        <Badge variant="outline" className="text-amber-400">
                          {fmtSec(a.cooldown / 1000)}
                          {a.cooldownReason ? ` · ${a.cooldownReason}` : ''}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-emerald-400">
                          ok
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge variant="outline" className={inUse.includes(a.id) ? 'text-amber-400' : 'text-emerald-400'}>
                          {inUse.includes(a.id) ? t('accounts.inUse') : t('accounts.free')}
                        </Badge>
                        <Badge variant="outline" className={a.ready ? 'text-emerald-400' : 'text-amber-400'}>
                          {a.ready ? t('accounts.ready') : t('accounts.warmingUp')}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-2"
                        title={t('accounts.viewDeviceFingerprint')}
                        onClick={() => showFp(a.id)}
                      >
                        <Fingerprint className={a.cooldownReason === 'CaptchaBlocked' || a.cooldownReason === 'Flagged' ? 'text-amber-400' : 'text-sky-400'} />
                        ver
                      </Button>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => api.clearCooldown(a.id).then(() => { toast.success(t('accounts.cooldownCleared')); load() })}>
                          <X /> limpar cooldown
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => api.refreshHeaders(a.id).then(() => toast.success(t('accounts.headersUpdated'))).catch((e) => toast.error(e.message))}>
                          <RefreshCw /> headers
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => remove(a.id)}>
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('accounts.addAccount')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="grid gap-2">
              <Label htmlFor="acc-email">{t('accounts.email')}</Label>
              <Input id="acc-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@qwen.example" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="acc-pass">{t("accounts.password")}</Label>
              <Input id="acc-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('accounts.password')} />
            </div>
            <Button className="gap-2" disabled={busy || !email.trim() || !password} onClick={add}>
              <Plus /> {t('accounts.add')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={fp !== null} onOpenChange={(o) => { if (!o) setFp(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Fingerprint className="text-sky-400" /> {t("accounts.fingerprintDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {t('accounts.fingerprintDescription')}
              {fp && fp.salt > 0 && t('accounts.saltRotated')}
            </DialogDescription>
          </DialogHeader>
          {fpLoading || !fp ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{t('accounts.loadingFingerprint')}</div>
          ) : (
            <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{t('accounts.salt')}: {fp.salt}</Badge>
                <Badge variant="outline">{t('accounts.identityVersion', { version: fp.resourceVersion })}</Badge>
              </div>
              <FpProfile profile={fp.profile} />
              {fp.lanes && fp.lanes.length > 0 && (
                <div className="flex flex-col gap-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('accounts.isolatedLanes', { count: fp.lanes.length })}
                  </div>
                  {fp.lanes.map((l) => (
                    <div key={l.lane} className="rounded-md border p-3">
                      <div className="mb-2 text-xs font-medium text-muted-foreground">Lane {l.lane} · {l.id}</div>
                      <FpProfile profile={l.profile} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FpRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-1.5 last:border-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-xs break-all">{value}</span>
    </div>
  )
}

function FpProfile({ profile }: { profile: FingerprintProfile }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-md border p-3">
      <FpRow label="User-Agent" value={profile.userAgent} />
      <FpRow label={t('accounts.fpPlatform')} value={`${profile.platform} ${profile.platformVersion} (${profile.architecture} ${profile.bitness})`} />
      <FpRow label="Chrome" value={`${profile.chromeVersion} (major ${profile.chromeMajor})`} />
      <FpRow label="Viewport" value={`${profile.viewport.width}×${profile.viewport.height} (outer +${profile.outerWidthOffset}/+${profile.outerHeightOffset})`} />
      <FpRow label="Hardware Concurrency" value={profile.hardwareConcurrency} />
      <FpRow label="Device Memory" value={`${profile.deviceMemory} GB`} />
      <FpRow label={t('accounts.fpLanguages')} value={profile.languages.join(', ')} />
      <FpRow label="WebGL" value={`${profile.webglVendor} / ${profile.webglRenderer}`} />
      <FpRow label="Color / Pixel depth" value={`${profile.colorDepth} / ${profile.pixelDepth}`} />
      <FpRow label="Canvas noise seed" value={profile.canvasNoiseSeed} />
      <FpRow label="Audio noise seed" value={profile.audioNoiseSeed} />
      <FpRow label="WebGL noise seed" value={profile.webglNoiseSeed} />
    </div>
  )
}

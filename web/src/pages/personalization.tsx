import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Loader2, Save, Sparkles, Wand2 } from 'lucide-react'
import { api, type PersonalizationConfig, type PersonalizationApplyResult } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from 'react-i18next'

const STYLE_OPTIONS = ['Default', 'Balanced', 'Concise', 'Socratic', 'Formal']

interface Preset {
  id: string
  label: string
  style: string
  blurb: string
  instruction: string
}

const PRESETS: Preset[] = [
  {
    id: 'padrao',
    label: 'personalization.presetDefault',
    style: 'Default',
    blurb: 'personalization.presetDefaultBlurb',
    instruction: '',
  },
  {
    id: 'equilibrio',
    label: 'personalization.presetBalanced',
    style: 'Balanced',
    blurb: 'personalization.presetBalancedBlurb',
    instruction: 'personalization.presetBalancedInstruction',
  },
  {
    id: 'conciso',
    label: 'personalization.presetConcise',
    style: 'Concise',
    blurb: 'personalization.presetConciseBlurb',
    instruction: 'personalization.presetConciseInstruction',
  },
  {
    id: 'socratico',
    label: 'personalization.presetSocratic',
    style: 'Socratic',
    blurb: 'personalization.presetSocraticBlurb',
    instruction: 'personalization.presetSocraticInstruction',
  },
  {
    id: 'formal',
    label: 'personalization.presetFormal',
    style: 'Formal',
    blurb: 'personalization.presetFormalBlurb',
    instruction: 'personalization.presetFormalInstruction',
  },
]

export function PersonalizationPage() {
  const { t } = useTranslation()
  const [cfg, setCfg] = useState<PersonalizationConfig>({ name: '', description: '', style: 'Default', instruction: '' })
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const [lastApply, setLastApply] = useState<PersonalizationApplyResult[] | null>(null)

  async function load() {
    try {
      setCfg(await api.personalization())
    } catch (err: any) {
      toast.error(err?.message || t('personalization.loadFailed'))
    }
  }

  useEffect(() => {
    load()
  }, [])

  function applyPreset(p: Preset) {
    setCfg((c) => ({ ...c, style: p.style, instruction: p.instruction ? t(p.instruction) : '' }))
    setActivePreset(p.id)
  }

  async function save() {
    setBusy(true)
    try {
      const r = await api.savePersonalization(cfg)
      setCfg(r.config)
      toast.success(t('personalization.saved'))
    } catch (err: any) {
      toast.error(err?.message || t('personalization.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function applyAll() {
    setApplying(true)
    setLastApply(null)
    try {
      const r = await api.applyPersonalization()
      setLastApply(r.results)
      if (r.failed === 0) toast.success(t('personalization.appliedAll', { count: r.succeeded }))
      else toast.warning(t('personalization.appliedPartial', { succeeded: r.succeeded, failed: r.failed }))
    } catch (err: any) {
      toast.error(err?.message || t('personalization.applyFailed'))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="text-sky-400" />{t('personalization.title')}</CardTitle>
          <CardDescription>
            {t('personalization.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pers-name">{t('personalization.nameLabel')}<span className="text-muted-foreground">(0/128)</span></Label>
              <Input
                id="pers-name"
                value={cfg.name}
                maxLength={128}
                placeholder={t('personalization.namePlaceholder')}
                onChange={(e) => { setCfg((c) => ({ ...c, name: e.target.value })); setActivePreset(null) }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pers-style">{t('personalization.styleLabel')}</Label>
              <div className="flex flex-wrap gap-2">
                {STYLE_OPTIONS.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    size="sm"
                    variant={cfg.style === s ? 'default' : 'outline'}
                    onClick={() => { setCfg((c) => ({ ...c, style: s })); setActivePreset(null) }}
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="pers-desc">{t('personalization.descLabel')}<span className="text-muted-foreground">(0/500)</span>
            </Label>
            <Textarea
              id="pers-desc"
              value={cfg.description}
              maxLength={500}
              rows={3}
              placeholder={t('personalization.descPlaceholder')}
              onChange={(e) => { setCfg((c) => ({ ...c, description: e.target.value })); setActivePreset(null) }}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="pers-inst">{t('personalization.instructionLabel')}<span className="text-muted-foreground">(0/2000)</span></Label>
            <Textarea
              id="pers-inst"
              value={cfg.instruction}
              maxLength={2000}
              rows={4}
              placeholder={t('personalization.instructionPlaceholder')}
              onChange={(e) => { setCfg((c) => ({ ...c, instruction: e.target.value })); setActivePreset(null) }}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={busy} className="gap-2">
              <Save />{t('personalization.save')}</Button>
            <Button onClick={applyAll} disabled={applying} variant="secondary" className="gap-2">
              {applying ? <Loader2 className="animate-spin" /> : <Wand2 />} {t('personalization.applyToAllAccounts')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('personalization.presetsTitle')}</CardTitle>
          <CardDescription>{t('personalization.presetsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p)}
                className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground ${
                  activePreset === p.id ? 'border-sky-500 bg-accent' : ''
                }`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="text-sm font-semibold">{t(p.label)}</span>
                  {activePreset === p.id && <Check className="size-4 text-sky-400" />}
                </div>
                <span className="text-xs text-muted-foreground">{t(p.blurb)}</span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {lastApply && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('personalization.applyResultTitle')}</CardTitle>
            <CardDescription>{t('personalization.applyResultDescription', { succeeded: lastApply.filter((r) => r.ok).length, failed: lastApply.filter((r) => !r.ok).length })}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
              {lastApply.map((r) => (
                <div key={r.accountId} className="flex items-center justify-between gap-2 border-b py-1.5 text-xs last:border-0">
                  <span className="truncate font-mono text-muted-foreground">{r.email || r.accountId.slice(0, 8)}</span>
                  {r.ok ? (
                    <Badge variant="outline" className="text-emerald-400">{t('personalization.ok')}</Badge>
                  ) : (
                    <Badge variant="outline" className="text-amber-400" title={r.error}>
                      {t('personalization.failedBadge')}{r.status ? ` (${r.status})` : ''}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

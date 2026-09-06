import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function Login() {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.ok) {
        setError(json?.error || t('login.authFailed'))
        return
      }
      window.location.reload()
    } catch (err: any) {
      setError(err?.message || t('login.networkError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="flex items-center justify-center gap-6 pb-2 pt-9 text-center">
          <img
            src={`${import.meta.env.BASE_URL}${document.documentElement.classList.contains('dark') ? 'qwenproxy.png' : 'qwenproxy-dark.png'}`}
            alt="QwenProxy"
            className="h-auto w-72 object-contain"
          />
        </CardHeader>
        <CardContent className="px-8 pb-8 pt-2">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="password" className="text-center">Senha do admin</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
            </div>
            {error ? <p className="text-center text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={busy}>
              {busy ? t('login.signingIn') : t('login.signIn')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
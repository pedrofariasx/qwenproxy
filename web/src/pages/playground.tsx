import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, MessageSquare, Send, Square, Terminal, Trash2 } from 'lucide-react'
import { api, type CatalogModel } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTranslation } from 'react-i18next'

function fmtContext(n?: number): string {
  if (!n) return ''
  if (n >= 1000000) return `${n / 1000000}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

function variantOf(id: string): 'base' | 'thinking' | 'no-thinking' {
  if (id.endsWith('-thinking')) return 'thinking'
  if (id.endsWith('-no-thinking')) return 'no-thinking'
  return 'base'
}

export function PlaygroundPage() {
  const { t } = useTranslation()
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [model, setModel] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [userMessage, setUserMessage] = useState('')
  const [stream, setStream] = useState(true)
  const [thinking, setThinking] = useState(false)
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState('')
  const [thinkingContent, setThinkingContent] = useState('')
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastPayloadRef = useRef<string>('')

  useEffect(() => {
    let cancelled = false
    api
      .models()
      .then((res) => {
        if (cancelled) return
        const list = res.catalog?.length ? res.catalog : res.models.map((m) => ({ ...m, requestCount: m.requestCount }))
        setCatalog(list)
        setModel((current) => {
          if (current && list.some((m) => m.id === current)) return current
          const preferred = [...list].sort((a, b) => b.requestCount - a.requestCount).find((m) => m.id === 'qwen-plus')
          return (preferred ?? [...list].find((m) => variantOf(m.id) === 'base') ?? list[0])?.id ?? 'qwen-plus'
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const selectedModel = useMemo(() => catalog.find((m) => m.id === model), [catalog, model])
  const topModels = useMemo(
    () => catalog.filter((m) => m.requestCount > 0).sort((a, b) => b.requestCount - a.requestCount).slice(0, 5),
    [catalog]
  )

  const buildPayload = useCallback(() => {
    const messages: Array<{ role: string; content: string }> = []
    if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt.trim() })
    messages.push({ role: 'user', content: userMessage.trim() })
    const payload: Parameters<typeof api.testChat>[0] = { model, messages, stream }
    if (thinking) payload.thinking = { type: 'enabled' }
    return payload
  }, [model, systemPrompt, userMessage, stream, thinking])

  async function handleSend() {
    if (!userMessage.trim()) return

    setLoading(true)
    setResponse('')
    setThinkingContent('')
    setDurationMs(null)
    const startedAt = performance.now()
    const payload = buildPayload()
    lastPayloadRef.current = JSON.stringify(payload, null, 2)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await api.testChat(payload)
      if (!res.ok) {
        const err = await res.text()
        setResponse(`Error ${res.status}: ${err}`)
        setLoading(false)
        return
      }

      if (stream) {
        const reader = res.body?.getReader()
        if (!reader) {
          setResponse('No response body')
          setLoading(false)
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6)
              if (data === '[DONE]') continue

              try {
                const json = JSON.parse(data)
                const delta = json.choices?.[0]?.delta
                if (delta?.content) setResponse((prev) => prev + delta.content)
                if (delta?.reasoning_content) setThinkingContent((prev) => prev + delta.reasoning_content)
              } catch {
                /* skip malformed chunks */
              }
            }
          }
        }
      } else {
        const json = await res.json()
        const message = json.choices?.[0]?.message
        if (message?.content) setResponse(message.content)
        if (message?.reasoning_content) setThinkingContent(message.reasoning_content)
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setResponse(`Error: ${err.message}`)
      }
    } finally {
      setLoading(false)
      abortRef.current = null
      setDurationMs(Math.round(performance.now() - startedAt))
    }
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  function handleClear() {
    abortRef.current?.abort()
    setResponse('')
    setThinkingContent('')
    setUserMessage('')
    setDurationMs(null)
  }

  async function handleCopy() {
    if (response) {
      await navigator.clipboard.writeText(response)
    }
  }

  async function handleCopyCurl() {
    try {
      const payload = JSON.parse(lastPayloadRef.current || '{}')
      const curl = [
        'curl -N http://localhost:3000/v1/chat/completions \\',
        '  -H "Content-Type: application/json" \\',
        `  -H "Authorization: Bearer ${t('playground.yourApiKey')}" \\`,
        `  -d '${JSON.stringify({ ...payload, stream: payload.stream ?? true })}'`,
      ].join('\n')
      await navigator.clipboard.writeText(curl)
    } catch {
      /* nothing to copy */
    }
  }

  const hasResponse = !!(response || thinkingContent)

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="lg:self-start">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="size-4" />
              {t('playground.request')}
            </CardTitle>
            <CardDescription>{t('playground.requestDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label>{t('playground.model')}</Label>
              <Select value={model || undefined} onValueChange={setModel}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('playground.selectModel')} />
                </SelectTrigger>
                <SelectContent>
                  {topModels.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>{t("playground.mostUsedGroup")}</SelectLabel>
                      {topModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          <span className="font-mono">{m.id}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  <SelectGroup>
                    <SelectLabel>{t("playground.allModelsGroup")}</SelectLabel>
                    {catalog.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="font-mono">{m.id}</span>
                      </SelectItem>
                    ))}
                    {catalog.length === 0 && <SelectItem value="qwen-plus">qwen-plus</SelectItem>}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {selectedModel ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" className="font-normal">ctx {fmtContext(selectedModel.contextWindow)}</Badge>
                  {variantOf(selectedModel.id) !== 'base' && (
                    <Badge variant="outline" className="font-normal">{variantOf(selectedModel.id)}</Badge>
                  )}
                </div>
              ) : null}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="psys">{t('playground.systemPrompt')} {systemPrompt ? <span className="text-muted-foreground">{t('playground.optional')}</span> : null}</Label>
              <textarea
                id="psys"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('playground.systemPromptPlaceholder')}
                rows={3}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs resize-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="pusr">{t('playground.userMessage')}</Label>
              <textarea
                id="pusr"
                value={userMessage}
                onChange={(e) => setUserMessage(e.target.value)}
                placeholder={t('playground.userMessagePlaceholder')}
                rows={6}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs resize-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleSend()
                  }
                }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch id="strm" checked={stream} onCheckedChange={setStream} />
                <Label htmlFor="strm" className="cursor-pointer">{t('playground.stream')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="thk" checked={thinking} onCheckedChange={setThinking} />
                <Label htmlFor="thk" className="cursor-pointer">{t("playground.thinkingLabel")}</Label>
              </div>
            </div>

            <div className="flex gap-2">
              {loading ? (
                <Button variant="destructive" onClick={handleStop}>
                  <Square className="size-4" />
                  {t('playground.stop')}
                </Button>
              ) : (
                <Button onClick={handleSend} disabled={!userMessage.trim()}>
                  <Send className="size-4" />
                  {t('playground.send')}
                </Button>
              )}
              <Button variant="outline" onClick={handleClear} disabled={!hasResponse && !userMessage}>
                <Trash2 className="size-4" />
                {t('playground.clear')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('playground.tipCtrlEnter')}</p>
          </CardContent>
        </Card>

        <Card className={hasResponse ? 'lg:self-start' : ''}>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="size-4" />
                {t('playground.response')}
              </CardTitle>
              <div className="flex items-center gap-2">
                {model && hasResponse ? <Badge variant="secondary" className="font-mono">{model}</Badge> : null}
                {durationMs != null ? (
                  <Badge variant="outline" className="font-mono">{durationMs}ms</Badge>
                ) : null}
              </div>
            </div>
            <CardDescription>
              {hasResponse
                ? `${thinkingContent ? t('playground.reasoningPrefix') : ''}${t('playground.characters', { count: response.length })}`
                : t('playground.responsePlaceholder')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!hasResponse ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <MessageSquare className="size-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {t('playground.noResponseHint')}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {thinkingContent && (
                  <div>
                    <Label className="mb-2 block text-xs text-muted-foreground">{t('playground.reasoningLabel')}</Label>
                    <div className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-4">
                      <pre className="font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">{thinkingContent}</pre>
                    </div>
                  </div>
                )}
                {response && (
                  <div>
                    <Label className="mb-2 block text-xs text-muted-foreground">{t('playground.contentLabel')}</Label>
                    <div className="max-h-96 overflow-auto rounded-md border bg-muted/20 p-4">
                      <pre className="font-mono text-sm whitespace-pre-wrap break-words">{response}</pre>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleCopy} disabled={!response}>
                    <Copy className="size-3.5" />
                    {t('playground.copyResponse')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleCopyCurl} disabled={!userMessage.trim()}>
                    <Terminal className="size-3.5" />
                    {t('playground.copyCurl')}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
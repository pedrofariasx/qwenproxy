import { useEffect, useId, useState } from 'react'
import i18next from 'i18next'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function fmtTime(t?: number): string {
  if (!t) return ''
  const d = new Date(t)
  return d.toLocaleTimeString(i18next.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Resolves a CSS variable to a concrete rgb() string for SVG attributes
 * (Recharts renders stroke/fill as attributes, which cannot use var()). */
export function themeColor(varName: string, fallback: string): string {
  try {
    const probe = document.createElement('span')
    probe.style.color = `var(${varName})`
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).color
    probe.remove()
    return resolved && resolved !== 'rgba(0, 0, 0, 0)' ? resolved : fallback
  } catch {
    return fallback
  }
}

/** Re-renders chart SVGs when the theme changes (App dispatches the event). */
function useThemeTick() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const onChange = () => setTick((t) => t + 1)
    window.addEventListener('qwenproxy:themechange', onChange)
    return () => window.removeEventListener('qwenproxy:themechange', onChange)
  }, [])
}

// Theme-aware chart tooltip (payload/label come from recharts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label, unit }: any) {
  if (!active || !payload?.length) return null
  const value = payload[0].value
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 text-muted-foreground">{label}</p>
      <p className="font-mono font-semibold">
        {typeof value === 'number' ? value.toLocaleString(i18next.language) : value} {unit || ''}
      </p>
    </div>
  )
}

interface ChartCardProps {
  title: string
  icon?: any
  badge?: React.ReactNode
  children: React.ReactNode
}

export function ChartCard({ title, icon: Icon, badge, children }: ChartCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {Icon ? <Icon className="size-4" /> : null}
          {title}
        </CardTitle>
        {badge}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function AreaTrend({ data, color = '#34d399', unit = '', height = 180 }: { data: { t: number; v: number }[]; color?: string; unit?: string; height?: number }) {
  useThemeTick()
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const points = data.map((d) => ({ name: fmtTime(d.t), v: d.v }))
  const gradId = `grad-${id}`
  const axisTick = { fontSize: 10, fill: themeColor('--muted-foreground', '#8b95a5') }
  const gridStroke = themeColor('--border', '#ffffff12')
  const cursorStroke = themeColor('--border', '#ffffff22')
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="name" tick={axisTick} tickLine={false} axisLine={false} minTickGap={50} />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: cursorStroke }} />
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${gradId})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function LineTrend({ data, color = '#f5b842', unit = '', height = 180 }: { data: { t: number; v: number }[]; color?: string; unit?: string; height?: number }) {
  useThemeTick()
  const points = data.map((d) => ({ name: fmtTime(d.t), v: d.v }))
  const axisTick = { fontSize: 10, fill: themeColor('--muted-foreground', '#8b95a5') }
  const gridStroke = themeColor('--border', '#ffffff12')
  const cursorStroke = themeColor('--border', '#27272a')
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
        <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="name" tick={axisTick} tickLine={false} axisLine={false} minTickGap={50} />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ stroke: cursorStroke }} />
        <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} activeDot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function BarTrend({ data, color = '#a78bfa', unit = '', height = 180 }: { data: { t: number; v: number }[]; color?: string; unit?: string; height?: number }) {
  useThemeTick()
  const points = data.map((d) => ({ name: fmtTime(d.t), v: d.v }))
  const axisTick = { fontSize: 10, fill: themeColor('--muted-foreground', '#8b95a5') }
  const gridStroke = themeColor('--border', '#ffffff12')
  const cursorFill = themeColor('--border', '#27272a22')
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={points} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
        <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="name" tick={axisTick} tickLine={false} axisLine={false} minTickGap={50} />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <Tooltip content={<ChartTooltip unit={unit} />} cursor={{ fill: cursorFill }} />
        <Bar dataKey="v" fill={color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}